# Third-Party Notices

## Tencent Weixin ClawBot protocol implementation

Parts of the Weixin iLink HTTP protocol, QR login, and attachment decryption
implementation were adapted from:

- Project: `@tencent-weixin/openclaw-weixin`
- Version used as the compatibility baseline: `2.4.6`
- Copyright: Tencent
- Source: https://github.com/Tencent/openclaw-weixin
- License: MIT

Chat2Codex does not install or depend on that package at runtime and does not
embed OpenClaw. The adapted code remains subject to the following license:

```text
MIT License

Copyright (c) Tencent

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
```
