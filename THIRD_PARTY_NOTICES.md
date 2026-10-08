# Third-party notices

The MIT license in `LICENSE` covers this tool's code and documentation. It does
not license Xenogears assets extracted from a user's disc. No disc image, model,
texture, animation resource, or generated Blender file is distributed here.

## Noah format reference

The scene animation decoder acknowledges the MIT-licensed Noah Xenogears
reimplementation by yaz0r: https://github.com/yaz0r/Noah. This notice preserves
the applicable upstream license. Noah itself is not bundled.

MIT License

Copyright (c) 2024 Noah authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## JavaScript dependencies

The Windows release includes these production dependencies. Each package's
original license is retained inside its directory under `node_modules/`.

| Package | License | Upstream |
| --- | --- | --- |
| `@gltf-transform/core` | MIT | https://github.com/donmccurdy/glTF-Transform |
| `@gltf-transform/extensions` | MIT | https://github.com/donmccurdy/glTF-Transform |
| `pngjs` | MIT | https://github.com/pngjs/pngjs |
| `property-graph` | MIT | https://github.com/donmccurdy/property-graph |
| `ktx-parse` | MIT | https://github.com/donmccurdy/ktx-parse |

## Node.js runtime

The Windows release includes Node.js and its complete upstream license file at
`runtime/LICENSE`. That file includes Node.js's MIT license and the notices and
licenses for its bundled components. Source checkouts do not bundle Node.js.
Upstream: https://nodejs.org/.

## Other format references and Blender

XenoREADER (https://github.com/J-D-K/XenoREADER, MIT), Micky's 2014
ImportXenogears importer, and the matching decompilation
(https://github.com/ladysilverberg/xenogears-decomp) informed format research.
Their source archives and executables are not included in this project.

Blender is installed separately and is not distributed in this release.
Upstream: https://www.blender.org/ (GNU GPL).
