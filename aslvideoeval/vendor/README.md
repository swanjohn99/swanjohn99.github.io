Mediabunny 1.62.1 is distributed under the Mozilla Public License 2.0 (see
MEDIABUNNY-LICENSE.txt). Its unmodified source is available at
https://github.com/Vanilagy/mediabunny/tree/v1.62.1 and in the pinned npm package.

`mediabunny.mjs` is a browser bundle built from that source with esbuild. It is
checked in so the app works offline without Node.js or an npm install. To rebuild,
run `npm ci` followed by `npm run build:video` from the project root.
