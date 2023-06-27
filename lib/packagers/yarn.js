'use strict';
/**
 * Yarn packager.
 *
 * Yarn specific packagerOptions (default):
 *   flat (false) - Use --flat with install
 *   ignoreScripts (false) - Do not execute scripts during install
 *   noNonInteractive (false) - Disable interactive mode when using Yarn 2 or above
 *   noFrozenLockfile (false) - Do not require an up-to-date yarn.lock
 *   networkConcurrency (8) - Specify number of concurrent network requests
 */

const _ = require('lodash');
const BbPromise = require('bluebird');
const Utils = require('../utils');
const findWorkspaceRoot = require('find-yarn-workspace-root');

class Yarn {
  // eslint-disable-next-line lodash/prefer-constant
  static get lockfileName() {
    return 'yarn.lock';
  }

  static get copyPackageSectionNames() {
    return ['resolutions'];
  }

  // eslint-disable-next-line lodash/prefer-constant
  static get mustCopyModules() {
    return false;
  }

  static isBerryVersion(version) {
    const versionNumber = version.charAt(0);
    const mainVersion = parseInt(versionNumber);
    return mainVersion > 1;
  }

  static getPackagerVersion(cwd) {
    const command = /^win/.test(process.platform) ? 'yarn.cmd' : 'yarn';
    const args = ['-v'];

    return Utils.spawnProcess(command, args, { cwd })
      .catch(err => {
        return BbPromise.resolve({ stdout: err.stdout });
      })
      .then(processOutput => processOutput.stdout);
  }

  static berryToTree(output) {
    return output
      .then((stdout) =>
        BbPromise.try(() => {
          const lines = Utils.splitLines(stdout).filter((l) => l);

          return _.reduce(
            lines,
            (acc, packageString) => {
              packageString = _.split(packageString, '"')[1];
              packageString = packageString.replace(/@npm:/, '@');

              const lastAtIndex = packageString.lastIndexOf('@');
              const name = packageString.slice(0, lastAtIndex);
              let version = packageString.slice(lastAtIndex + 1);

              if (version.indexOf('workspace:') !== -1) {
                version = '';
              }

              return _.set(acc, name, { version, dependencies: {} });
            },
            {}
          );
        })
      )
      .then((tree) => {
        return {
          problems: [],
          dependencies: tree,
        };
      });
  }

  static getProdDependencies(cwd, depth) {
    const isBerry = true; //Yarn.isBerryVersion(version);

    const command = /^win/.test(process.platform) ? 'yarn.cmd' : 'yarn';
    const args = isBerry
      ? ['info', '--name-only', '--json', '-R']
      : ['list', `--depth=${depth || 1}`, '--json', '--production'];

    // If we need to ignore some errors add them here
    const ignoredYarnErrors = [];

    const output = Utils.spawnProcess(command, args, {
      // This one doesn't get us all packages in berry, just root packages.
      // Better to depend on serverless-plugin-monorepo
      // cwd: findWorkspaceRoot(cwd) || cwd
      cwd
    })
      .catch(err => {
        if (err instanceof Utils.SpawnError) {
          // Only exit with an error if we have critical npm errors for 2nd level inside
          const errors = _.split(err.stderr, '\n');
          const failed = _.reduce(
            errors,
            (failed, error) => {
              if (failed) {
                return true;
              }
              return (
                !_.isEmpty(error) &&
                !_.some(ignoredYarnErrors, ignoredError => _.startsWith(error, `npm ERR! ${ignoredError.npmError}`))
              );
            },
            false
          );

          if (!failed && !_.isEmpty(err.stdout)) {
            return BbPromise.resolve({ stdout: err.stdout });
          }
        }

        return BbPromise.reject(err);
      })
      .then(processOutput => processOutput.stdout);

    if (isBerry) {
      return this.berryToTree(output);
    }

    return output
      .then(stdout =>
        BbPromise.try(() => {
          const lines = Utils.splitLines(stdout);
          const parsedLines = _.map(lines, Utils.safeJsonParse);
          return _.find(parsedLines, line => line && line.type === 'tree');
        })
      )
      .then(parsedTree => {
        const convertTrees = trees =>
          _.reduce(
            trees,
            (__, tree) => {
              const splitModule = _.split(tree.name, '@');
              // If we have a scoped module we have to re-add the @
              if (_.startsWith(tree.name, '@')) {
                splitModule.splice(0, 1);
                splitModule[0] = '@' + splitModule[0];
              }
              __[_.first(splitModule)] = {
                version: _.join(_.tail(splitModule), '@'),
                dependencies: convertTrees(tree.children)
              };
              return __;
            },
            {}
          );

        const trees = _.get(parsedTree, 'data.trees', []);
        const result = {
          problems: [],
          dependencies: convertTrees(trees)
        };
        return result;
      });
  }

  static rebaseLockfile(pathToPackageRoot, lockfile) {
    const fileVersionMatcher = /[^"/]@(?:file:)?((?:\.\/|\.\.\/).*?)[":,]/gm;
    const replacements = [];
    let match;

    // Detect all references and create replacement line strings
    while ((match = fileVersionMatcher.exec(lockfile)) !== null) {
      replacements.push({
        oldRef: match[1],
        newRef: _.replace(`${pathToPackageRoot}/${match[1]}`, /\\/g, '/')
      });
    }

    // Replace all lines in lockfile
    return _.reduce(replacements, (__, replacement) => _.replace(__, replacement.oldRef, replacement.newRef), lockfile);
  }

  static install(cwd, packagerOptions, version) {
    if (packagerOptions.noInstall) {
      return BbPromise.resolve();
    }
    const isBerry = Yarn.isBerryVersion(version);

    const command = /^win/.test(process.platform) ? 'yarn.cmd' : 'yarn';
    const args = ['install'];
    // Convert supported packagerOptions
    if (!packagerOptions.noNonInteractive && !isBerry) {
      args.push('--non-interactive');
    }
    if (!packagerOptions.noFrozenLockfile) {
      if (isBerry) {
        args.push('--immutable');
      } else {
        args.push('--frozen-lockfile');
      }
    }
    if (packagerOptions.ignoreScripts) {
      args.push('--ignore-scripts');
    }
    if (packagerOptions.networkConcurrency) {
      args.push(`--network-concurrency ${packagerOptions.networkConcurrency}`);
    }

    return Utils.spawnProcess(command, args, { cwd }).return();
  }

  // "Yarn install" prunes automatically
  static prune(cwd, packagerOptions, version) {
    return Yarn.install(cwd, packagerOptions, version);
  }

  static runScripts(cwd, scriptNames) {
    const command = /^win/.test(process.platform) ? 'yarn.cmd' : 'yarn';
    return BbPromise.mapSeries(scriptNames, scriptName => {
      const args = ['run', scriptName];

      return Utils.spawnProcess(command, args, { cwd });
    }).return();
  }
}

module.exports = Yarn;
