/* eslint-disable @typescript-eslint/no-explicit-any */
// import { version as nextVersion } from './node_modules/next/package.json';
import { getSentryRelease } from '@sentry/node';
import { logger } from '@sentry/utils';
import defaultWebpackPlugin, { SentryCliPluginOptions } from '@sentry/webpack-plugin';
import * as SentryWebpackPlugin from '@sentry/webpack-plugin';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Next requires that plugins be tagged with the same version number as the currently-running `next.js` package, so
 * modify our `package.json` to trick it into thinking we comply. Run before the plugin is loaded at server startup.
 */
export function syncPluginVersionWithNextVersion(): void {
  // TODO Once we get at least to TS 2.9, we can use `"resolveJsonModule": true` in our `compilerOptions` and we'll be
  // able to do:
  // import { version as nextVersion } from './node_modules/next/package.json';

  // Use `path.resolve()` for require statements so that we know we're working relative to the project directory (which
  // is the current working directory when this code is running and therefore is what `path` uses as a starting point)
  // rather than basing our path on the location of this source file (which is what would happen if we were to require
  // relative paths directly). (It also has the advantage that if it throws `module not found`, it's clear exactly what
  // it's looking for/where it's looking.)

  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-unsafe-member-access
  const nextVersion = (require(path.resolve('./node_modules/next/package.json')) as any).version;
  if (!nextVersion) {
    logger.error('[next-plugin-sentry] Cannot read next.js version. Plug-in will not work.');
    return;
  }

  const pluginPackageDotJsonPath = './node_modules/@sentry/next-plugin-sentry/package.json';
  const pluginPackageDotJsonAbsPath = path.resolve(pluginPackageDotJsonPath);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pluginPackageDotJson = require(pluginPackageDotJsonAbsPath); // see TODO above
  if (!pluginPackageDotJson) {
    logger.error(`[next-plugin-sentry] Cannot read ${pluginPackageDotJsonPath}. Plug-in will not work.`);
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  (pluginPackageDotJson as any).version = nextVersion;
  fs.writeFileSync(pluginPackageDotJsonAbsPath, JSON.stringify(pluginPackageDotJson));
}

type WebpackConfig = { devtool: string; plugins: Array<{ [key: string]: any }> };
type NextConfigExports = {
  experimental?: { plugins: boolean };
  plugins?: string[];
  productionBrowserSourceMaps?: boolean;
  webpack?: (config: WebpackConfig, { dev }: { dev: boolean }) => WebpackConfig;
};

export function withSentryConfig(
  providedExports: NextConfigExports = {},
  providedWebpackPluginOptions: Partial<SentryCliPluginOptions> = {},
): NextConfigExports {
  const defaultWebpackPluginOptions = {
    release: getSentryRelease(),
    url: process.env.SENTRY_URL,
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    configFile: 'sentry.properties',
    stripPrefix: ['webpack://_N_E/'],
    urlPrefix: `~/_next`,
    include: '.next/',
    ignore: ['node_modules', 'webpack.config.js'],
  };
  const webpackPluginOptionOverrides = Object.keys(defaultWebpackPluginOptions)
    .concat('dryrun')
    .map(key => key in Object.keys(providedWebpackPluginOptions));
  if (webpackPluginOptionOverrides.length > 0) {
    logger.warn(
      '[next-plugin-sentry] You are overriding the following automatically-set SentryWebpackPlugin config options:\n' +
        `\t${webpackPluginOptionOverrides.toString()},\n` +
        "which has the possibility of breaking source map upload and application. This is only a good idea if you know what you're doing.",
    );
  }

  return {
    experimental: { plugins: true },
    plugins: [...(providedExports.plugins || []), '@sentry/next-plugin-sentry'],
    productionBrowserSourceMaps: true,
    webpack: (config, { dev }) => {
      if (!dev) {
        // Ensure quality source maps in production. (Source maps aren't uploaded in dev, and besides, Next doesn't let
        // you change this is dev even if you want to - see
        // https://github.com/vercel/next.js/blob/master/errors/improper-devtool.md.)
        config.devtool = 'source-map';
      }
      config.plugins.push(
        // TODO it's not clear how to do this better, but there *must* be a better way
        new ((SentryWebpackPlugin as unknown) as typeof defaultWebpackPlugin)({
          dryRun: dev,
          ...defaultWebpackPluginOptions,
          ...providedWebpackPluginOptions,
        }),
      );
      return config;
    },
  };
}

syncPluginVersionWithNextVersion();
