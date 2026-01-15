19:14:12.544 Running build in Washington, D.C., USA (East) – iad1
19:14:12.544 Build machine configuration: 4 cores, 8 GB
19:14:12.656 Cloning github.com/arbenoruci-pixel/rian (Branch: main, Commit: a80b58e)
19:14:12.931 Cloning completed: 274.000ms
19:14:13.411 Restored build cache from previous deployment (6xz6tuhqjkre5xpBRwnPs4EnRaX2)
19:14:13.686 Running "vercel build"
19:14:14.587 Vercel CLI 50.3.1
19:14:14.879 Installing dependencies...
19:14:15.964 
19:14:15.964 up to date in 857ms
19:14:15.964 
19:14:15.964 136 packages are looking for funding
19:14:15.965   run `npm fund` for details
19:14:15.993 Detected Next.js version: 14.2.3
19:14:15.998 Running "npm run build"
19:14:16.116 
19:14:16.116 > rian-main-full@1.0.0 build
19:14:16.116 > next build
19:14:16.116 
19:14:16.816   ▲ Next.js 14.2.3
19:14:16.816 
19:14:16.877    Creating an optimized production build ...
19:14:17.597  ⚠ Found lockfile missing swc dependencies, run next locally to automatically patch
19:14:20.044 Failed to compile.
19:14:20.045 
19:14:20.045 ./app/api/backup/run/route.js
19:14:20.045 Module parse failed: Top-level-await is only supported in EcmaScript Modules
19:14:20.045 File was processed with these loaders:
19:14:20.045  * ./node_modules/next/dist/build/webpack/loaders/next-flight-loader/index.js
19:14:20.045  * ./node_modules/next/dist/build/webpack/loaders/next-swc-loader.js
19:14:20.045 You may need an additional loader to handle the result of these loaders.
19:14:20.045 Error: Top-level-await is only supported in EcmaScript Modules
19:14:20.046     at /vercel/path0/node_modules/next/dist/compiled/webpack/bundle5.js:28:756227
19:14:20.046     at Hook.eval [as call] (eval at create (/vercel/path0/node_modules/next/dist/compiled/webpack/bundle5.js:13:28636), <anonymous>:7:16)
19:14:20.046     at Hook.CALL_DELEGATE [as _call] (/vercel/path0/node_modules/next/dist/compiled/webpack/bundle5.js:13:25906)
19:14:20.046     at JavascriptParser.walkAwaitExpression (/vercel/path0/node_modules/next/dist/compiled/webpack/bundle5.js:28:977555)
19:14:20.046     at JavascriptParser.walkExpression (/vercel/path0/node_modules/next/dist/compiled/webpack/bundle5.js:28:976238)
19:14:20.046     at JavascriptParser.walkVariableDeclaration (/vercel/path0/node_modules/next/dist/compiled/webpack/bundle5.js:28:974296)
19:14:20.046     at JavascriptParser.walkStatement (/vercel/path0/node_modules/next/dist/compiled/webpack/bundle5.js:28:964555)
19:14:20.046     at JavascriptParser.walkStatements (/vercel/path0/node_modules/next/dist/compiled/webpack/bundle5.js:28:961772)
19:14:20.047     at JavascriptParser.parse (/vercel/path0/node_modules/next/dist/compiled/webpack/bundle5.js:28:992222)
19:14:20.047     at /vercel/path0/node_modules/next/dist/compiled/webpack/bundle5.js:28:405457
19:14:20.047 
19:14:20.047 Import trace for requested module:
19:14:20.047 ./app/api/backup/run/route.js
19:14:20.047 
19:14:20.057 
19:14:20.057 > Build failed because of webpack errors
19:14:20.082 Error: Command "npm run build" exited with 1