/*
 * Copyright 2015, Yahoo Inc.
 * Copyrights licensed under the New BSD License.
 * See the accompanying LICENSE file for terms.
 */

import * as p from 'path';
import {writeFileSync} from 'fs';
import {sync as mkdirpSync} from 'mkdirp';
import printICUMessage from './print-icu-message';

const COMPONENT_NAMES = [
  'FormattedMessage',
  'FormattedHTMLMessage',
];

const FUNCTION_NAMES = [
  'defineMessages',
  //'translator',
];

const DESCRIPTOR_PROPS = new Set(['id', 'description', 'defaultMessage']);

const separator = '-| DEBUG |-------------------------------------------------------->>>>'
const consoleLog = (title, obj) => {
  console.log(separator)
  console.log(title, obj)
  console.log(separator)
}

export default function () {
  function getModuleSourceName(opts) {
    return opts.moduleSourceName || 'react-intl';
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

      if (key === 'defaultMessage') {
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

  function storeMessage({id, description, defaultMessage}, path, state) {
    const {opts, reactIntl} = state;

    if (!(id && defaultMessage)) {
      throw path.buildCodeFrameError(
        '[React Intl] Message Descriptors require an `id` and `defaultMessage`.'
      );
    }

    if (reactIntl.messages.has(id)) {
      let existing = reactIntl.messages.get(id);

      if (description !== existing.description ||
        defaultMessage !== existing.defaultMessage) {

        throw path.buildCodeFrameError(
          `[React Intl] Duplicate message id: "${id}", ` +
          'but the `description` and/or `defaultMessage` are different.'
        );
      }
    }

    if (opts.enforceDescriptions && !description) {
      throw path.buildCodeFrameError(
        '[React Intl] Message must have a `description`.'
      );
    }

    reactIntl.messages.set(id, {id, description, defaultMessage});
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

  return {
    visitor: {
      Program: {
        enter(path, state) {
          state.reactIntl = {
            messages: new Map(),
          };
        },

        exit(path, state) {
          const {file, opts, reactIntl} = state;
          const {basename, filename}    = file.opts;

          let descriptors = [...reactIntl.messages.values()];
          file.metadata['react-intl'] = {messages: descriptors};

          if (opts.messagesDir && descriptors.length > 0) {
            // Make sure the relative path is "absolute" before
            // joining it with the `messagesDir`.
            let relativePath = p.join(
              p.sep,
              p.relative(process.cwd(), filename)
            );

            let messagesFilename = p.join(
              opts.messagesDir,
              p.dirname(relativePath),
              basename + '.json'
            );

            let messagesFile = JSON.stringify(descriptors, null, 2);

            mkdirpSync(p.dirname(messagesFilename));
            writeFileSync(messagesFilename, messagesFile);
          }
        },
      },

      JSXOpeningElement(path, state) {
        const {file, opts}     = state;
        const moduleSourceName = getModuleSourceName(opts);

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
          let attributes = path.get('attributes')
            .filter((attr) => attr.isJSXAttribute());

          let descriptor = createMessageDescriptor(
            attributes.map((attr) => [
              attr.get('name'),
              attr.get('value'),
            ]),
            {isJSXSource: true}
          );

          descriptor.defaultMessage = descriptor.id

          // In order for a default message to be extracted when
          // declaring a JSX element, it must be done with standard
          // `key=value` attributes. But it's completely valid to
          // write `<FormattedMessage {...descriptor} />`, because it
          // will be skipped here and extracted elsewhere. When the
          // `defaultMessage` prop exists, the descriptor will be
          // checked.
          if (descriptor.defaultMessage) {
            storeMessage(descriptor, path, state);
          }
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

        function processMessageObject(messageObj) {
          assertObjectExpression(messageObj);

          let properties = messageObj.get('properties');

          let descriptor = createMessageDescriptor(
            properties.map((prop) => [
              prop.get('key'),
              prop.get('value'),
            ])
          );

          // this will allow us to skip 'defaultMessage' property.
          descriptor.defaultMessage = descriptor.id;

          if (!descriptor.defaultMessage) {
            throw path.buildCodeFrameError(
              '[React Intl] Message is missing a `defaultMessage`.'
            );
          }

          storeMessage(descriptor, path, state);
        }

        function getPropertyValueByName(properties, name) {
          const property = properties.filter(prop => prop.get('key').node.name === name)

          return property[0] && property[0].get('value').node.value
        }

        //moduleSourceName = 'skybase-core/utils/translator'

        if (referencesImport(callee, moduleSourceName, FUNCTION_NAMES)) {
          let messagesObj = path.get('arguments')[0];

          assertObjectExpression(messagesObj);

          if (messagesObj.has('elements')) {
            const elements = messagesObj.get('elements');
            let resultObject = {};

            elements.forEach(el => {
              const properties = el.get('properties');
              const id = getPropertyValueByName(properties, 'id');

              if (!resultObject[id]) {
                resultObject[id] = {};
              }

              properties.forEach(prop => {
                const key = prop.get('key').node.name;
                const value = prop.get('value').node.value;

                resultObject[id][key] = value;
              });
            })

            const stringified = JSON.stringify(resultObject)
            path.replaceWithSourceString(`defineMessages(${stringified})`);
          }
          else {
            messagesObj.get('properties')
              .map((prop) => prop.get('value'))
              .forEach(processMessageObject);
          }
        }
      },
    },
  };
}
