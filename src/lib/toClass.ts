/**
 * Copyright 2018 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {createEnumDeclaration, createEnumMember, createIntersectionTypeNode, createKeywordTypeNode, createModifiersFromModifierFlags, createParenthesizedType, createStringLiteral, createTypeAliasDeclaration, createTypeLiteralNode, createTypeReferenceNode, createUnionTypeNode, EnumDeclaration, ModifierFlags, Statement, SyntaxKind, TypeAliasDeclaration, TypeNode} from 'typescript';

import {withComments} from './comments';
import {toClassName, toEnumName, toScopedName} from './names';
import {Property, PropertyType} from './toProperty';
import {ObjectPredicate, TObject, TPredicate, TSubject} from './triple';
import {SchemaObject, SchemaString} from './types';
import {GetComment, GetSubClassOf, GetType, IsClassType, IsDataType, IsPropertyType, TTypeName} from './wellKnown';

export type ClassMap = Map<string, Class>;

export interface BySubject {
  Subject: TSubject;
  values: ReadonlyArray<ObjectPredicate>;
}
export interface TypedTopic extends BySubject {
  types: ReadonlyArray<TTypeName>;
}

function arrayOf<T>(...args: Array<T|undefined|null>): T[] {
  return args.filter(
      (elem): elem is T => elem !== null && typeof elem !== 'undefined');
}

export class Class {
  private comment?: string;
  private readonly children: Class[] = [];
  private readonly parents: Class[] = [];
  private readonly _props: Property[] = [];
  private readonly _enums: EnumValue[] = [];

  private aliasesBuiltin(): boolean {
    for (const parent of this.parents) {
      if (parent instanceof Builtin || parent.aliasesBuiltin()) {
        return true;
      }
    }
    return false;
  }

  isLeaf(): boolean {
    return this.children.length === 0 && !this.aliasesBuiltin();
  }

  properties() {
    return this.isLeaf() ?
        [
          new Property(
              '@type',
              new PropertyType(
                  this.subject,
                  new SchemaString(
                      toScopedName(this.subject), /*language=*/undefined)),
              ),
          ...this._props
        ] :
        this._props;
  }

  protected baseName() {
    return toClassName(this.subject) + 'Base';
  }
  private enumName() {
    return toClassName(this.subject) + 'Enum';
  }
  private className() {
    return toClassName(this.subject);
  }

  constructor(readonly subject: TSubject) {}
  add(value: {Predicate: TPredicate; Object: TObject},
      classMap: ClassMap): boolean {
    const c = GetComment(value);
    if (c) {
      if (this.comment) {
        console.error(`Duplicate comments provided on class ${
            this.subject.toString()}. It will be overwritten.`);
      }
      this.comment = c.comment;
      return true;
    }
    const s = GetSubClassOf(value);
    if (s) {
      const parentClass = classMap.get(s.subClassOf.toString());
      if (parentClass) {
        this.parents.push(parentClass);
        parentClass.children.push(this);
      } else {
        throw new Error(`Couldn't find parent of ${this.subject.toString()}, ${
            s.subClassOf.toString()}`);
      }
      return true;
    }

    if (GetType(value)) return true;  // We used types already.

    return false;
  }
  addProp(p: Property) {
    this._props.push(p);
  }
  addEnum(e: EnumValue) {
    this._enums.push(e);
  }

  private baseNode(): TypeNode {
    // Properties part.
    const propLiteral =
        createTypeLiteralNode(this.properties().map(prop => prop.toNode()));

    const parentTypes = this.parents.map(
        parent => createTypeReferenceNode(parent.baseName(), []));
    const parentNode = parentTypes.length === 0 ?
        null :
        parentTypes.length === 1 ?
        parentTypes[0] :
        createParenthesizedType(createIntersectionTypeNode(parentTypes));

    if (parentNode && propLiteral.members.length > 0) {
      return createIntersectionTypeNode([parentNode, propLiteral]);
    } else if (parentNode) {
      return parentNode;
    } else if (propLiteral.members.length > 0) {
      return propLiteral;
    } else {
      return createKeywordTypeNode(SyntaxKind.NeverKeyword);
    }
  }

  private baseDecl(): TypeAliasDeclaration {
    const baseNode = this.baseNode();

    return createTypeAliasDeclaration(
        /*decorators=*/[], /*modifiers=*/[], this.baseName(),
        /*typeParameters=*/[], baseNode);
  }

  private nonEnumType(): TypeNode {
    const children = this.children.map(
        child =>
            createTypeReferenceNode(child.className(), /*typeArguments=*/[]));

    const childrenNode = children.length === 0 ?
        null :
        children.length === 1 ?
        children[0] :
        createParenthesizedType(createUnionTypeNode(children));

    if (childrenNode) {
      return childrenNode;
    } else {
      return createTypeReferenceNode(this.baseName(), /*typeArguments=*/[]);
    }
  }

  private totalType(): TypeNode {
    const isEnum = this._enums.length > 0;

    if (isEnum) {
      return createUnionTypeNode([
        createTypeReferenceNode(this.enumName(), []),
        createParenthesizedType(this.nonEnumType()),
      ]);
    } else {
      return this.nonEnumType();
    }
  }

  private enumDecl(): EnumDeclaration|undefined {
    if (this._enums.length === 0) return undefined;

    return createEnumDeclaration(
        /* decorators= */[],
        createModifiersFromModifierFlags(ModifierFlags.Export), this.enumName(),
        this._enums.map(e => e.toNode()));
  }

  toNode() {
    const typeValue: TypeNode = this.totalType();
    const declaration = withComments(
        this.comment,
        createTypeAliasDeclaration(
            /* decorators = */[],
            createModifiersFromModifierFlags(ModifierFlags.Export),
            this.className(),
            [],
            typeValue,
            ));

    return arrayOf<Statement>(this.enumDecl(), this.baseDecl(), declaration);
  }
}

export class Builtin extends Class {
  constructor(
      private readonly name: string, private readonly equivTo: string,
      private readonly doc?: string) {
    super(new SchemaObject(name, /*layer=*/undefined));
  }

  toNode() {
    return [
      withComments(
          this.doc,
          createTypeAliasDeclaration(
              /*decorators=*/[],
              createModifiersFromModifierFlags(ModifierFlags.Export), this.name,
              /*typeParameters=*/[],
              createTypeReferenceNode(this.equivTo, []))),
    ];
  }

  protected baseName() {
    return this.name;
  }
}

export class EnumValue {
  readonly INSTANCE = 'EnumValue';

  private comment?: string;
  constructor(private readonly value: TSubject) {}

  add(value: ObjectPredicate, map: ClassMap) {
    // First, "Type" containment.
    // A Topic can have multiple types. So the triple we're adding now could
    // either be:
    // 1. An already processed well-known type (e.g. the Topic is also a Class,
    //    as well as being an enum).
    // 2. The Type of the Enum.
    //
    // e.g.: SurgicalProcedure (schema.org/SurgicalProcedure) is both a class
    //       having the "Class" type, and also an instance of the
    //       MedicalProcedureType (schema.org/MedicalProcedureType) enum.
    //       Therefore, an Enum will contain two TTypeName ObjectPredicates:
    //       one of Type=Class, and another of Type=MedicalProcedureType.
    const type = GetType(value);
    if (type) {
      if (IsClassType(type) || IsDataType(type)) return true;

      const enumObject = map.get(type.toString());
      if (!enumObject) {
        throw new Error(`Couldn't find ${type.toString()} in classes.`);
      }
      enumObject.addEnum(this);
      return true;
    }

    // Comment.
    const comment = GetComment(value);
    if (comment) {
      if (this.comment) {
        throw new Error(`Attempt to add comment on ${
            this.value.toString()} enum but one already exists.`);
      }
      this.comment = comment.comment;
      return true;
    }

    return false;
  }

  toNode() {
    return withComments(
        this.comment,
        createEnumMember(
            toEnumName(this.value),
            createStringLiteral(this.value.toString())));
  }
}

export function toClass(cls: Class, group: BySubject, map: ClassMap): Class {
  const rest: ObjectPredicate[] = [];
  for (const value of group.values) {
    const added = cls.add(value, map);
    if (!added) rest.push(value);
  }
  return cls;
}

const wellKnownTypes = [
  new Builtin('Text', 'string'), new Builtin('Number', 'number'),
  new Builtin(
      'Time', 'string',
      'DateTime represented in string, e.g. 2017-01-04T17:10:00-05:00.'),
  new Builtin('Boolean', 'boolean')
];

function ForwardDeclareClasses(topics: ReadonlyArray<TypedTopic>): ClassMap {
  const classes = new Map<string, Class>();
  for (const wk of wellKnownTypes) {
    classes.set(wk.subject.toString(), wk);
  }
  for (const topic of topics) {
    if (!topic.types.some(IsClassType)) continue;
    classes.set(topic.Subject.toString(), new Class(topic.Subject));
  }

  if (classes.size === 0) {
    throw new Error('Expected Class topics to exist.');
  }

  return classes;
}

function BuildClasses(topics: ReadonlyArray<TypedTopic>, classes: ClassMap) {
  for (const topic of topics) {
    if (!topic.types.some(IsClassType)) continue;

    const cls = classes.get(topic.Subject.toString());
    if (!cls) {
      throw new Error(`Class ${
          topic.Subject.toString()} should have been forward declared.`);
    }
    toClass(cls, topic, classes);
  }
}

export function ProcessClasses(topics: ReadonlyArray<TypedTopic>): ClassMap {
  const classes = ForwardDeclareClasses(topics);
  BuildClasses(topics, classes);
  return classes;
}

export function FindProperties(topics: ReadonlyArray<TypedTopic>):
    ReadonlyArray<BySubject> {
  const properties = topics.filter(topic => topic.types.some(IsPropertyType));
  if (properties.length === 0) {
    throw new Error('Unexpected: Property Topics to exist.');
  }
  return properties;
}
