/*
 * Copyright 2015, Yahoo Inc.
 * Copyrights licensed under the New BSD License.
 * See the accompanying LICENSE file for terms.
 */

import * as p from 'path';
import {writeFileSync} from 'fs';
import {sync as mkdirpSync} from 'mkdirp';
import { includes, last, head } from 'lodash';
import printICUMessage from './print-icu-message';

const COMPONENT_NAMES = [
  'FormattedMessage',
  'FormattedHTMLMessage',
];

const FUNCTION_NAMES = [
  'translate',
];

const DEFAULT_MODULE_SOURCE_NAME = 'skybase-core/utils/translate';
const DEFAULT_REACT_INTL_SOURCE_NAME = 'react-intl';
const DESCRIPTOR_PROPS = new Set(['id', 'description']);

// @todo Move to plugin's internal state.
let importSet = false;
let convertedClassNames = [];

const CLASS_TYPES = {
  CLASS: 'CLASS',
  STATELESS_FUNCTION: 'STATELESS_FUNCTION',
}

let classType = null;

export default function ({ types: t }) {

  function getModuleSourceName(opts, defaultSource = DEFAULT_MODULE_SOURCE_NAME) {
    return opts.moduleSourceName || defaultSource;
  }

  function getMessageDescriptorKey(path) {
    if (path.isIdentifier() || path.isJSXIdentifier()) {
      return path.node.name;
    }

    let evaluated = path.evaluate();
    if (evaluated.confident) {
      return evaluated.value;
    }

    throw path.buildCodeFrameError(
      '[React Intl] Messages must be statically evaluate-able for extraction.'
    );
  }

  function getMessageDescriptorValue(path) {
    if (path.isJSXExpressionContainer()) {
      path = path.get('expression');
    }

    let evaluated = path.evaluate();
    if (evaluated.confident) {
      return evaluated.value;
    }

    throw path.buildCodeFrameError(
      '[React Intl] Messages must be statically evaluate-able for extraction.'
    );
  }

  function createMessageDescriptor(propPaths, options = {}) {
    const {isJSXSource = false} = options;

    return propPaths.reduce((hash, [keyPath, valuePath]) => {
      let key = getMessageDescriptorKey(keyPath);

      if (!DESCRIPTOR_PROPS.has(key)) {
        return hash;
      }

      let value = getMessageDescriptorValue(valuePath).trim();

      // @todo Handle that.
      if (key === 'id') {
        try {
          hash[key] = printICUMessage(value);
        } catch (parseError) {
          if (isJSXSource &&
            valuePath.isLiteral() &&
            value.indexOf('\\\\') >= 0) {

            throw valuePath.buildCodeFrameError(
              '[React Intl] Message failed to parse. ' +
              'It looks like `\\`s were used for escaping, ' +
              'this won\'t work with JSX string literals. ' +
              'Wrap with `{}`. ' +
              'See: http://facebook.github.io/react/docs/jsx-gotchas.html'
            );
          }

          throw valuePath.buildCodeFrameError(
            '[React Intl] Message failed to parse. ' +
            'See: http://formatjs.io/guides/message-syntax/',
            parseError
          );
        }
      } else {
        hash[key] = value;
      }

      return hash;
    }, {});
  }

  function storeMessage({id, description}, path, state) {
    const {opts, reactIntl} = state;

    if (!id) {
      throw path.buildCodeFrameError(
        '[React Intl] Message Descriptors require an `id` attribute.'
      );
    }

    if (reactIntl.messages.has(id)) {
      let existing = reactIntl.messages.get(id);

      if (description !== existing.description) {

        throw path.buildCodeFrameError(
          `[React Intl] Duplicate message id: "${id}", ` +
          'but the `description` are different.'
        );
      }
    }

    if (opts.enforceDescriptions && !description) {
      throw path.buildCodeFrameError(
        '[React Intl] Message must have a `description`.'
      );
    }

    reactIntl.messages.set(id, {id, description});
  }

  function customReferencesImport(moduleSource, importName, sourcePathNormalizer) {
    if (!this.isReferencedIdentifier()) return false;

    var binding = this.scope.getBinding(this.node.name);
    if (!binding || binding.kind !== "module") return false;

    var path = binding.path;
    var parent = path.parentPath;
    if (!parent.isImportDeclaration()) return false;

    const normalizedSource = sourcePathNormalizer ? sourcePathNormalizer(parent.node.source.value) : parent.node.source.value;

    if (normalizedSource === moduleSource) {

      if (!importName) return true;
    } else {
      return false;
    }

    if (path.isImportDefaultSpecifier() && importName === "default") {
      return true;
    }

    if (path.isImportNamespaceSpecifier() && importName === "*") {
      return true;
    }

    if (path.isImportSpecifier() && path.node.imported.name === importName) {
      return true;
    }

    return false;
  }

  /**
   * @desc
   * Removes first part of path to make it comparable with relative path.
   *
   * For example:
   * The path ../../../../src/skybase-core/...
   *
   * will be converted into:
   * skybase-core/...
   *
   * @param sourcePath
   * @returns {*}
   */
  function normalizer(sourcePath) {
    // @todo Load dynamically from babelrc
    const aliases = [
      'skybase-components',
      'skybase-core',
      'skybase-shell',
      'skybase-styling',
    ]
    let result = sourcePath

    aliases.forEach(alias => {
      result = result.replace(new RegExp('^.*?' + alias), alias)
    })

    return result
  }

  function referencesImport(path, mod, importedNames) {
    if (!(path.isIdentifier() || path.isJSXIdentifier())) {
      return false;
    }

    return importedNames.some((name) => customReferencesImport.apply(path, [mod, name, normalizer]));
  }

  function processClassComponent(path, state) {
    const declaration = path.node.declaration;

    if (!declaration.id) {
      // @todo Support also 'default' class
      return;
    }

    const { superClass } = declaration;
    if (!superClass) {
      return;
    }

    // @todo Very naive implementation, handle also extends of React.Component
    if (t.isIdentifier(superClass) && superClass.name !== 'Component') {
      return;
    }

    // @todo Very naive implementation, handle also extends of React.Component
    if (t.isMemberExpression(superClass) && superClass.object.name != 'React' && superClass.property.name != 'Component') {
      return;
    }

    const className = declaration.id.name;
    const newClassName = '_' + className;

    if (className === 'SbBaseComponent') {
      // @todo Implement!
      console.log('------------------------------ SKIPPED!')
      return;
    }

    if (includes(convertedClassNames, className)) {
      return;
    }

    convertedClassNames.push(newClassName);
    console.log('injected:', className)

    path.node.declaration.id.name = newClassName;

    if (!importSet) {
      path.insertBefore(
        t.importDeclaration(
          [
            t.importSpecifier(
              t.identifier('injectIntl'), // local
              t.identifier('injectIntl') // imported
            )
          ],
          t.stringLiteral('react-intl')
        )
      )

      importSet = true;
    }

    // @todo Refactor! It's located here twice!
    path.insertAfter(
      t.exportNamedDeclaration(
        t.variableDeclaration(
          'const',  // kind
          [
            t.variableDeclarator(
              t.identifier(className),
              t.callExpression(
                t.identifier('injectIntl'),
                [
                  t.identifier(newClassName)
                ]
              )
            )
          ]
        ),    // declaration
        [],   // specifiers
        null  // source (StringLiteral)
      )
    )
  }

  function isReactComponent(path) {
    const declarations = path.node.declaration.declarations;
    if (!declarations) {
      return false;
    }

    const { name } = declarations[0].id
    const init = declarations[0].init

    console.log('------ class:', name)

    // If the first letter of function is capital, then we consider it as a react component.
    // First, check first letter of name is capital.
    if (name[0] !== name[0].toUpperCase()) {
      console.log('------------ ignore:', 'Is not camelcase')
      return false;
    }

    // then, init part must be an arrow function.
    if (!t.isArrowFunctionExpression(init)) {
      console.log('------------ ignore:', 'Is not arrow function')
      return false;
    }

    const { body } = init;
    // @todo support also JSX no-return (arrow) statement, .e.g. const x = () => (<p>hello</p>)
    if (!t.isBlockStatement(body)) {
      console.log('------------ ignore:', 'has no block statement')
      return;
    }

    const blockBody = body.body;
    const lastStatement = last(blockBody)

    if (!t.isReturnStatement(lastStatement)) {
      console.log('------------ ignore:', 'has no return statement at the end.')
      return false;
    }

    const { argument } = lastStatement;

    console.log('------------ return statement is JSX', t.isJSXElement(argument))

    return t.isJSXElement(argument)

  }

  function processStatelessComponent(path, state) {
    if (!isReactComponent(path)) {
      return;
    }

    const funcDeclaration = path.node.declaration.declarations[0];
    const className = funcDeclaration.id.name;
    const newClassName = '_' + className;

    if (includes(convertedClassNames, className)) {
      return;
    }

    convertedClassNames.push(newClassName);
    convertedClassNames.push(className);

    console.log('injected:', className)

    funcDeclaration.id.name = newClassName;

    path.replaceWith(
      t.exportNamedDeclaration(
        t.variableDeclaration(
          'const',  // kind
          [
            funcDeclaration
          ]
        ),    // declaration
        [],   // specifiers
        null  // source (StringLiteral)
      )
    )

    if (!importSet) {
      path.insertBefore(
        t.importDeclaration(
          [
            t.importSpecifier(
              t.identifier('injectIntl'), // local
              t.identifier('injectIntl') // imported
            )
          ],
          t.stringLiteral('react-intl')
        )
      )

      importSet = true;
    }

    path.insertAfter(
      t.exportNamedDeclaration(
        t.variableDeclaration(
          'const',  // kind
          [
            t.variableDeclarator(
              t.identifier(className),
              t.callExpression(
                t.identifier('injectIntl'),
                [
                  t.identifier(newClassName)
                ]
              )
            )
          ]
        ),    // declaration
        [],   // specifiers
        null  // source (StringLiteral)
      )
    )
  }

  function getJSXAttributeById(path, id) {
    const attributes = path.get('attributes');
    const attribute = attributes.filter(attr => t.isJSXAttribute(attr) && t.isJSXIdentifier(attr.node.name) && attr.node.name.name === id);

    return attribute ? head(attribute) : null;
  }

  return {
    visitor: {
      Program: {
        enter(path, state) {
          state.reactIntl = {
            messages: new Map(),
          };

          const { opts } = state;
          console.log('------- OPTS', opts)

          importSet = false;
          convertedClassNames = [];
        },

        exit(path, state) {
          const {file, opts, reactIntl} = state;
          const {basename, filename}    = file.opts;

          //console.log('-------------------- STATE', state)

          let descriptors = [...reactIntl.messages.values()];
          file.metadata['react-intl'] = {messages: descriptors};

          console.log('----------------- descriptors.length', descriptors.length)
          console.log('----------------- opts.messagesDir', opts.messagesDir)

          if (!opts.messagesDir) {
            return;
          }

          const messagesDir = opts.messagesDir || './build/messages/core/';

          if (messagesDir && descriptors.length > 0) {
            // Make sure the relative path is "absolute" before
            // joining it with the `messagesDir`.
            let relativePath = p.join(
              p.sep,
              p.relative(process.cwd(), filename)
            );

            let messagesFilename = p.join(
              messagesDir,
              p.dirname(relativePath),
              basename + '.json'
            );

            const normalizedMessages = descriptors
              .map(message => {
                if (message.description == null) {
                  delete message['description'];
                }

                return message;
              })
              .sort((a, b) => {
                a = a.id.toLowerCase();
                b = b.id.toLowerCase();

                if (a > b) {
                  return 1;
                }
                else if (a < b) {
                  return -1;
                }
                else {
                  return 0;
                }
              });

            let messagesFile = JSON.stringify(normalizedMessages, null, 2);

            mkdirpSync(p.dirname(messagesFilename));
            writeFileSync(messagesFilename, messagesFile);
          }
        },
      },

      ImportDeclaration(path, state) {
      },

      ExportDeclaration(path, state) {
        // @todo Implement!
      },

      ExportNamedDeclaration(path, state) {
        const declaration = path.node.declaration

        if (t.isClassDeclaration(declaration)) {
          classType = CLASS_TYPES.CLASS;
          processClassComponent(path, state);
        } else if (t.isVariableDeclaration(declaration)) {
          classType = CLASS_TYPES.STATELESS_FUNCTION;
          processStatelessComponent(path, state);
        }
      },

      JSXOpeningElement(path, state) {
        const {file, opts}     = state;
        const moduleSourceName = getModuleSourceName(opts, DEFAULT_REACT_INTL_SOURCE_NAME);

        let name = path.get('name');

        if (name.referencesImport(moduleSourceName, 'FormattedPlural')) {
          file.log.warn(
            `[React Intl] Line ${path.node.loc.start.line}: ` +
            'Default messages are not extracted from ' +
            '<FormattedPlural>, use <FormattedMessage> instead.'
          );

          return;
        }

        if (referencesImport(name, moduleSourceName, COMPONENT_NAMES)) {
          let attributes = path.get('attributes');

          const idAttribute = getJSXAttributeById(path, 'id')
          const descriptionAttribute = getJSXAttributeById(path, 'description')

          if (!idAttribute) {
            // Supported JSX tag without 'ID' attribute will be ignored.
            return;
          }

          path.node.attributes.push(
            t.jSXAttribute(
              t.jSXIdentifier('defaultMessage'),   // name
              t.stringLiteral(idAttribute.node.value.value)   // value
            )
          )

          const id = idAttribute.node.value.value
          const description = descriptionAttribute ? descriptionAttribute.node.value.value : null;

          // @todo Validate.
          storeMessage({id, description}, path, state);
        }
      },

      CallExpression(path, state) {
        let moduleSourceName = getModuleSourceName(state.opts);
        const callee = path.get('callee');

        function assertObjectExpression(node) {
          if (!(node && (node.isObjectExpression() || node.isArrayExpression() || node.isStringLiteral()))) {
            throw path.buildCodeFrameError(
              `[React Intl] \`${callee.node.name}()\` must be ` +
              'called with an object expression with values ' +
              'that are React Intl Message Descriptors, also ' +
              'defined as object expressions.'
            );
          }
        }

        if (referencesImport(callee, moduleSourceName, FUNCTION_NAMES)) {
          const args = path.node.arguments

          if (args.length < 2) {
            path.node.arguments.push(
              t.objectExpression([])
            )
          }

          if (args.length < 3) {
            path.node.arguments.push(
              t.nullLiteral()
            )
          }

          const thisProps = t.memberExpression(
            t.thisExpression(),
            t.identifier('props'),
            false
          )
          if (args.length < 4) {
            path.node.arguments.push(
              classType == CLASS_TYPES.CLASS ? thisProps : t.identifier('props') // @todo Implement detection of props variable.
            )
          }

          path.replaceWith(
            t.callExpression(
              t.memberExpression(
                t.identifier('translate'),  // object
                t.identifier('call'),      // property
                false                       // computed
              ), // callee
              [
                t.thisExpression()
              ].concat(args)
            )
          )

          const id = args[0].value
          const description = !t.isNullLiteral(args[2]) ? args[2].value : null;

          console.log('------ FOUND:', id);
          // @todo Add validations.
          storeMessage({id, description}, path, state);
        }
      },
    },
  };
}
