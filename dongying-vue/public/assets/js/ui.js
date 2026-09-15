/* =============================================================================
 * ui.js —— 通用组件层（无框架，字符串模板 + 事件委托）
 * ========================================================================== */
(function (g) {
  'use strict';

  /* ---- 图标 ---- */
  const P = {
    home: 'M3 10.5 12 3l9 7.5M5 9.5V21h14V9.5',
    radar: 'M12 12 19 7M12 21a9 9 0 1 0-9-9M12 12a4.5 4.5 0 1 0 4.5 4.5M21 12h-2M12 3v2',
    chart: 'M4 20V9M10 20V4M16 20v-7M22 20H2',
    plan: 'M4 5h16v16H4zM4 9h16M9 3v4M15 3v4M8 14h3M8 17h6',
    check: 'M4 6h16v13H4zM9 12.5l2.2 2.2L16 10',
    alert: 'M12 4 2.5 20h19zM12 10v4M12 17.5v.5',
    bird: 'M3 8c3-2 5 1 8-1 2-1.4 4-3 7-3-1 4-2 5-4 6 1 3-1 8-6 8-4 0-6-3-6-6 0-2 1-4 1-4z',
    zone: 'M12 3 3 8v8l9 5 9-5V8zM3 8l9 5 9-5M12 13v8',
    device: 'M4 5h16v6H4zM4 13h16v6H4zM7 8h.01M7 16h.01',
    tool: 'M14.5 3.5a4 4 0 0 0 5 5L21 7l-4-4zM3 21l9.5-9.5M9 15l-3.5 3.5',
    mon: 'M3 5h18v11H3zM8 20h8M12 16v4M6.5 12l2.5-3 2.5 2.5L15 7l2.5 5',
    api: 'M9 4H5v5M15 4h4v5M9 20H5v-5M15 20h4v-5M9 12h6M12 9v6',
    gavel: 'M14 3 21 10l-3 3-7-7zM11 6 5 12l4 4 6-6M3 21h10',
    archive: 'M3 5h18v4H3zM5 9v11h14V9M9 13h6',
    search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM16 16l5 5',
    fullscreen: 'M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5',
    bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',
    clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
    cloud: 'M6 18h12a4 4 0 0 0 .4-8 6.5 6.5 0 0 0-12.3 1.7A3.2 3.2 0 0 0 6 18z',
    user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
    settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4.9 4.9l2.2 2.2M16.9 16.9l2.2 2.2M3 12h3M18 12h3M4.9 19.1l2.2-2.2M16.9 7.1l2.2-2.2M12 3v3M12 18v3',
    shield: 'M12 3 20 6v6c0 5-3.4 8-8 9-4.6-1-8-4-8-9V6zM9 12l2 2 4-5',
    logout: 'M10 5H4v14h6M14 8l4 4-4 4M8 12h10',
    warning: 'M12 4 2.5 20h19zM12 10v4M12 17.5v.5',
    close: 'M5 5l14 14M19 5 5 19',
    plane: 'M3 13l18-9-6 16-3-6-5-1zM12 14l3-3',
    clipboard: 'M8 5h8M9 3h6v4H9zM6 5H4v16h16V5h-2M8 11h8M8 15h8',
    scale: 'M12 4v17M5 7h14M7 7l-4 7h8zM17 7l-4 7h8zM8 21h8',
    link: 'M10 14l4-4M8 17H6a4 4 0 0 1 0-8h3M16 7h2a4 4 0 0 1 0 8h-3',
    file: 'M6 3h8l4 4v14H6zM14 3v5h5M9 12h6M9 16h6',
    database: 'M4 6c0-2 16-2 16 0s-16 2-16 0zM4 6v6c0 2 16 2 16 0V6M4 12v6c0 2 16 2 16 0v-6',
    lock: 'M6 10h12v11H6zM9 10V7a3 3 0 0 1 6 0v3M12 14v3',
    unlock: 'M6 10h12v11H6zM9 10V7a3 3 0 0 1 5.5-1.7M12 14v3',
    pen: 'M4 20l4.5-1L19 8.5 15.5 5 5 15.5zM13.5 7l3.5 3.5',
    download: 'M12 3v12M7 10l5 5 5-5M4 20h16',
    pause: 'M8 5v14M16 5v14',
    play: 'M8 5v14l11-7z',
    trash: 'M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6',
    save: 'M5 3h12l2 2v16H5zM8 3v6h8V3M8 15h8v6',
    skip: 'M5 5l9 7-9 7zM18 5v14',
    ban: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM6 6l12 12',
    camera: 'M4 7h4l2-3h4l2 3h4v12H4zM12 10a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
    video: 'M3 6h13v12H3zM16 10l5-3v10l-5-3z',
    location: 'M12 21s7-6.1 7-12a7 7 0 1 0-14 0c0 5.9 7 12 7 12zM12 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
    bolt: 'M13 2 5 14h7l-1 8 8-12h-7z',
    landing: 'M3 17h18M5 6l13 7-2 2-5-2-3 2-2-1 2-3z',
    arrowRight: 'M5 12h14M14 7l5 5-5 5',
    flag: 'M5 21V4M5 5h11l-2 4 2 4H5',
    star: 'M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z',
    image: 'M4 5h16v14H4zM7 15l3-3 3 3 2-2 3 3M8 9h.01',
    trend: 'M4 18l5-6 4 3 7-9M15 6h5v5',
    receipt: 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6',
    mail: 'M3 5h18v14H3zM3 7l9 7 9-7',
    folder: 'M3 6h7l2 2h9v11H3z',
    plus: 'M12 5v14M5 12h14',
    upload: 'M12 16V4M7 9l5-5 5 5M4 20h16',
    refresh: 'M20 7v5h-5M4 17v-5h5M18.5 9a7 7 0 0 0-11.8-2.5L4 10M5.5 15a7 7 0 0 0 11.8 2.5L20 14',
    stop: 'M7 7h10v10H7z',
    estop: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8 8h8v8H8z',
    expand: 'M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5',
    zoomIn: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM8 11h6M11 8v6M16 16l5 5',
    zoomOut: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM8 11h6M16 16l5 5',
    chevronDown: 'M6 9l6 6 6-6',
    list: 'M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01',
    copy: 'M8 8h11v11H8zM5 16H4V4h12v1',
    check: 'M5 12l4 4L19 6',
    cross: 'M6 6l12 12M18 6 6 18'
  };
  const icon = n => `<svg class="svg-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false" stroke-linecap="round" stroke-linejoin="round"><path d="${P[n] || P.home}"/></svg>`;

  /* 设备类型视觉字典：协议 A v8.6 / B v2.4 附录 + 当前设备台账类型。
     图形只表示种类，状态颜色仍由页面决定；不按设备名称猜测种类。
     雷达/光电复用现有 UI 图标，其余复用已安装 @vicons/ionicons5 的原始 SVG。
     Ionicons (MIT), Copyright (c) 2015-present Ionic: https://github.com/ionic-team/ionicons */
  /* Ionicons SVG license (MIT)
     Copyright (c) 2015-present Ionic (http://ionic.io/)
     Permission is hereby granted, free of charge, to any person obtaining a copy
     of this software and associated documentation files (the "Software"), to deal
     in the Software without restriction, including without limitation the rights
     to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
     copies of the Software, and to permit persons to whom the Software is
     furnished to do so, subject to the following conditions:
     The above copyright notice and this permission notice shall be included in
     all copies or substantial portions of the Software.
     THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
     IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
     FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
     AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
     LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
     OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
     THE SOFTWARE. */
  const DEVICE_SVG = {
    "CellularOutline": "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><rect x=\"416\" y=\"96\" width=\"64\" height=\"320\" rx=\"8\" ry=\"8\" fill=\"none\" stroke=\"currentColor\" stroke-linejoin=\"round\" stroke-width=\"32\"></rect><rect x=\"288\" y=\"176\" width=\"64\" height=\"240\" rx=\"8\" ry=\"8\" fill=\"none\" stroke=\"currentColor\" stroke-linejoin=\"round\" stroke-width=\"32\"></rect><rect x=\"160\" y=\"240\" width=\"64\" height=\"176\" rx=\"8\" ry=\"8\" fill=\"none\" stroke=\"currentColor\" stroke-linejoin=\"round\" stroke-width=\"32\"></rect><rect x=\"32\" y=\"304\" width=\"64\" height=\"112\" rx=\"8\" ry=\"8\" fill=\"none\" stroke=\"currentColor\" stroke-linejoin=\"round\" stroke-width=\"32\"></rect></svg>",
    "PulseOutline": "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M48 320h64l64-256l64 384l64-224l32 96h64\"></path><circle cx=\"432\" cy=\"320\" r=\"32\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></circle></svg>",
    "ShieldOutline": "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><path d=\"M463.1 112.37C373.68 96.33 336.71 84.45 256 48c-80.71 36.45-117.68 48.33-207.1 64.37C32.7 369.13 240.58 457.79 256 464c15.42-6.21 223.3-94.87 207.1-351.63z\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path></svg>",
    "NavigateOutline": "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><path d=\"M448 64L64 240.14h200a8 8 0 0 1 8 8V448z\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path></svg>",
    "FlashOutline": "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><path d=\"M315.27 33L96 304h128l-31.51 173.23a2.36 2.36 0 0 0 2.33 2.77h0a2.36 2.36 0 0 0 1.89-.95L416 208H288l31.66-173.25a2.45 2.45 0 0 0-2.44-2.75h0a2.42 2.42 0 0 0-1.95 1z\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path></svg>",
    "CarSportOutline": "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><path d=\"M469.71 234.6c-7.33-9.73-34.56-16.43-46.08-33.94s-20.95-55.43-50.27-70S288 112 256 112s-88 4-117.36 18.63s-38.75 52.52-50.27 70s-38.75 24.24-46.08 33.97S29.8 305.84 32.94 336s9 48 9 48h86c14.08 0 18.66-5.29 47.46-8c31.6-3 62.6-4 80.6-4s50 1 81.58 4c28.8 2.73 33.53 8 47.46 8h85s5.86-17.84 9-48s-2.04-91.67-9.33-101.4z\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M400 384h56v16h-56z\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M56 384h56v16H56z\"></path><path d=\"M364.47 309.16c-5.91-6.83-25.17-12.53-50.67-16.35S279 288 256.2 288s-33.17 1.64-57.61 4.81s-42.79 8.81-50.66 16.35C136.12 320.6 153.42 333.44 167 335c13.16 1.5 39.47.95 89.31.95s76.15.55 89.31-.95c13.56-1.65 29.62-13.6 18.85-25.84z\" fill=\"currentColor\"></path><path d=\"M431.57 243.05a3.23 3.23 0 0 0-3.1-3c-11.81-.42-23.8.42-45.07 6.69a93.88 93.88 0 0 0-30.08 15.06c-2.28 1.78-1.47 6.59 1.39 7.1a455.32 455.32 0 0 0 52.82 3.1c10.59 0 21.52-3 23.55-12.44a52.41 52.41 0 0 0 .49-16.51z\" fill=\"currentColor\"></path><path d=\"M80.43 243.05a3.23 3.23 0 0 1 3.1-3c11.81-.42 23.8.42 45.07 6.69a93.88 93.88 0 0 1 30.08 15.06c2.28 1.78 1.47 6.59-1.39 7.1a455.32 455.32 0 0 1-52.82 3.1c-10.59 0-21.52-3-23.55-12.44a52.41 52.41 0 0 1-.49-16.51z\" fill=\"currentColor\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M432 192h16\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M64 192h16\"></path><path d=\"M78 211s46.35-12 178-12s178 12 178 12\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path></svg>",
    "ScanOutline": "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><path d=\"M336 448h56a56 56 0 0 0 56-56v-56\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path><path d=\"M448 176v-56a56 56 0 0 0-56-56h-56\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path><path d=\"M176 448h-56a56 56 0 0 1-56-56v-56\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path><path d=\"M64 176v-56a56 56 0 0 1 56-56h56\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path></svg>",
    "CompassOutline": "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><path d=\"M448 256c0-106-86-192-192-192S64 150 64 256s86 192 192 192s192-86 192-192z\" fill=\"none\" stroke=\"currentColor\" stroke-miterlimit=\"10\" stroke-width=\"32\"></path><path d=\"M350.67 150.93l-117.2 46.88a64 64 0 0 0-35.66 35.66l-46.88 117.2a8 8 0 0 0 10.4 10.4l117.2-46.88a64 64 0 0 0 35.66-35.66l46.88-117.2a8 8 0 0 0-10.4-10.4zM256 280a24 24 0 1 1 24-24a24 24 0 0 1-24 24z\" fill=\"currentColor\"></path></svg>",
    "RadioOutline": "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><circle cx=\"256\" cy=\"256.02\" r=\"32\" fill=\"currentColor\"></circle><path d=\"M184.25 192.25a96 96 0 0 0 0 127.52\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path><path d=\"M327.77 319.77a96 96 0 0 0 0-127.52\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path><path d=\"M133.28 141.28a168 168 0 0 0 0 229.44\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path><path d=\"M378.72 370.72a168 168 0 0 0 0-229.44\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path><path d=\"M435 416a240.34 240.34 0 0 0 0-320\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path><path d=\"M77 96a240.34 240.34 0 0 0 0 320\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path></svg>",
    "CodeWorkingOutline": "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><circle cx=\"256\" cy=\"256\" r=\"26\" fill=\"currentColor\"></circle><circle cx=\"346\" cy=\"256\" r=\"26\" fill=\"currentColor\"></circle><circle cx=\"166\" cy=\"256\" r=\"26\" fill=\"currentColor\"></circle><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M160 368L32 256l128-112\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M352 368l128-112l-128-112\"></path></svg>",
    "MegaphoneOutline": "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><path d=\"M407.94 52.22S321.3 160 240 160H80a16 16 0 0 0-16 16v96a16 16 0 0 0 16 16h160c81.3 0 167.94 108.23 167.94 108.23c6.06 8 24.06 2.52 24.06-9.83V62c0-12.31-17-18.82-24.06-9.78z\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path><path d=\"M64 256s-16-6-16-32s16-32 16-32\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path><path d=\"M448 246s16-4.33 16-22s-16-22-16-22\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M256 160v128\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M112 160v128\"></path><path d=\"M144 288v168a8 8 0 0 0 8 8h53a16 16 0 0 0 15.29-20.73C211.91 416.39 192 386.08 192 336h16a16 16 0 0 0 16-16v-16a16 16 0 0 0-16-16h-16\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\"></path></svg>",
    "IdCardOutline": "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><rect x=\"96\" y=\"32\" width=\"320\" height=\"448\" rx=\"48\" fill=\"none\" stroke=\"currentColor\" stroke-linejoin=\"round\" stroke-width=\"32\"></rect><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M208 80h96\"></path><path d=\"M333.48 284.51A39.65 39.65 0 0 0 304 272c-11.6 0-22.09 4.41-29.54 12.43s-11.2 19.12-10.34 31C265.83 338.91 283.72 358 304 358s38.14-19.09 39.87-42.55c.88-11.78-2.82-22.77-10.39-30.94z\" fill=\"currentColor\"></path><path d=\"M371.69 448H236.31a12.05 12.05 0 0 1-9.31-4.17a13 13 0 0 1-2.76-10.92c3.25-17.56 13.38-32.31 29.3-42.66C267.68 381.06 285.6 376 304 376s36.32 5.06 50.46 14.25c15.92 10.35 26.05 25.1 29.3 42.66a13 13 0 0 1-2.76 10.92a12.05 12.05 0 0 1-9.31 4.17z\" fill=\"currentColor\"></path></svg>",
    "HardwareChipOutline": "<svg xmlns=\"http://www.w3.org/2000/svg\" xmlns:xlink=\"http://www.w3.org/1999/xlink\" viewBox=\"0 0 512 512\"><rect x=\"80\" y=\"80\" width=\"352\" height=\"352\" rx=\"48\" ry=\"48\" fill=\"none\" stroke=\"currentColor\" stroke-linejoin=\"round\" stroke-width=\"32\"></rect><rect x=\"144\" y=\"144\" width=\"224\" height=\"224\" rx=\"16\" ry=\"16\" fill=\"none\" stroke=\"currentColor\" stroke-linejoin=\"round\" stroke-width=\"32\"></rect><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M256 80V48\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M336 80V48\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M176 80V48\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M256 464v-32\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M336 464v-32\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M176 464v-32\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M432 256h32\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M432 336h32\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M432 176h32\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M48 256h32\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M48 336h32\"></path><path fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\" stroke-width=\"32\" d=\"M48 176h32\"></path></svg>"
};
  const DEVICE_TYPES = [
    ['radar', '雷达', 'radar', ['RADAR', '雷达设备', '1']],
    ['eo', '光电', 'camera', ['EO', 'OE', '光电设备', '3']],
    ['5ga', '5G-A 基站', 'CellularOutline', ['5GA', 'FIVE_G_A', '5G-A', '5G-A基站', '0']],
    ['spec', '频谱设备', 'PulseOutline', ['SPEC', '频谱', '2']],
    ['cm', '反制设备', 'ShieldOutline', ['CM', 'COUNTERMEASURE', '反制', '4']],
    ['dec', '诱骗设备', 'NavigateOutline', ['DEC', '诱骗', '5']],
    ['ifr', '干扰设备', 'FlashOutline', ['IFR', '干扰', '6']],
    ['cv', '指挥车', 'CarSportOutline', ['CV', '7']],
    ['isrs', '察打一体', 'ScanOutline', ['ISRS', '侦打一体', '8']],
    ['aoa', 'AOA', 'CompassOutline', ['AOA', '无线电测向（AOA）', '9']],
    ['tdoa', 'TDOA', 'RadioOutline', ['TDOA', '10']],
    ['dcd', '协议破解', 'CodeWorkingOutline', ['DCD', '协议破解设备', '11']],
    ['bsc', '驱鸟炮', 'MegaphoneOutline', ['BSC', '驱鸟炮设备', '12']],
    ['rid', 'RemoteID', 'IdCardOutline', ['RID', 'REMOTEID', 'RemoteID设备', '102']],
    ['fusion', '融合感知箱', 'HardwareChipOutline', ['FUSION_BOX', '融合终端']]
  ];
  const DEVICE_ALIASES = new Map();
  const UNKNOWN_DEVICE = Object.freeze({ key: 'unknown', label: '设备类型未知', icon: 'device' });
  DEVICE_TYPES.forEach(([key, label, glyph, aliases]) => {
    const meta = Object.freeze({ key, label, icon: glyph });
    [key, label, ...aliases].forEach(alias => DEVICE_ALIASES.set(alias.toUpperCase(), meta));
  });
  function deviceMeta(device) {
    const values = typeof device === 'object' && device !== null
      ? [device.device_type_code, device.typeCode, device.device_type_abbr, device.deviceTypeAbbr,
        device.source_type, device.deviceType, device.device_type_name, device.type]
      : [device];
    for (const value of values) {
      if (value == null || String(value).trim() === '') continue;
      const found = DEVICE_ALIASES.get(String(value).trim().toUpperCase());
      if (found) return found;
    }
    return UNKNOWN_DEVICE;
  }
  function deviceIcon(device) {
    const meta = deviceMeta(device);
    let svg = DEVICE_SVG[meta.icon] || icon(meta.icon);
    if (!svg.includes('class=')) svg = svg.replace('<svg ', '<svg class="svg-icon" aria-hidden="true" focusable="false" ');
    // 静态受信任图标；设备接口只用于枚举查询，不插入返回的 HTML。
    return svg.replace('<svg ', '<svg width="1em" height="1em" data-device-icon="' + meta.key + '" ');
  }

  /* ---- 数值格式 ---- */
  const num = n => (n == null ? '—' : Number(n).toLocaleString('en-US'));
  const pct = (a, b, d) => b ? (a / b * 100).toFixed(d == null ? 1 : d) + '%' : '0%';
  const money = n => '¥' + Number(n).toLocaleString('en-US');
  function delta(v, opts) {
    opts = opts || {};
    const good = opts.lowerBetter ? v < 0 : v > 0;   // 业务上"高更好"还是"低更好"
    const cls = v === 0 ? 'flat' : (opts.neutral ? 'flat' : (good ? (opts.goodIsRed ? 'up' : 'dn') : (opts.goodIsRed ? 'dn' : 'up')));
    const arr = v === 0 ? '—' : (v > 0 ? '↑' : '↓');
    return `<span class="${cls}">${arr} ${Math.abs(v)}%</span>`;
  }

  /* ---- 标签 ---- */
  const RISK_C = { '超高风险': 't-red', '高风险': 't-red', '中风险': 't-amber', '低风险': 't-blue', '未识别': 't-gray' };
  const LEGAL_C = { '非法': 't-red', '异常': 't-orange', '待确认': 't-amber', '合法': 't-green', '不适用': 't-gray' };
  const STAT_C = {
    '在线': 't-green', '离线': 't-gray', '异常': 't-red', '告警': 't-orange',
    /* A7 告警状态枚举 */ '新建': 't-amber', '已确认': 't-cyan', '已关闭': 't-green', '误报': 't-blue',
    /* 业务与日志状态标签 */ '待核实': 't-amber', '待归档': 't-blue',
    '正常': 't-green', '已处置': 't-green', '处置中': 't-orange',   /* 已处置/处置中 属目标跟踪与风险事件枚举，非 alarm_status */
    '已结案': 't-green', '处理中': 't-orange', '待处理': 't-amber', '跟踪中': 't-cyan',
    '成功': 't-green', '失败': 't-red', '已归档': 't-green', '生效中': 't-green',
    '执行中': 't-cyan', '已完成': 't-green', '待执行': 't-blue', '已终止': 't-gray',
    '待核验': 't-amber', '良好': 't-green', '一般': 't-amber', '未知': 't-gray',
    '高': 't-red', '中': 't-amber', '低': 't-blue'
  };
  const tag = (t, c) => `<span class="tag ${c || STAT_C[t] || RISK_C[t] || LEGAL_C[t] || 't-gray'}">${t}</span>`;
  const risk = r => `<span class="tag ${RISK_C[r] || 't-gray'}">${r}</span>`;
  const legal = l => `<span class="tag ${LEGAL_C[l] || 't-gray'}">${l}</span>`;
  const dotState = s => `<span class="dot-s" style="background:${s === '在线' || s === '正常' ? '#2fd06e' : s === '离线' ? '#8ca0be' : '#ff4d5e'}"></span>${s}`;

  /* ---- 检查语义图标 ----
     「检查完成」与「检查通过」必须分开：绿勾只许表示合规通过，
     命中违规=红叉、存在偏差=橙三角、无判据=灰"不可判定"。
     label===false 只出图标（窄列场景），传字符串可覆盖默认文字。 */
  const STATE_IC = {
    pass: { i: 'check', c: '#2fd06e', t: '通过' },
    warn: { i: 'warning', c: '#ffb020', t: '存在偏差' },
    fail: { i: 'cross', c: '#ff4d5e', t: '命中违规' },
    na: { i: null, c: 'var(--txt-3)', t: '不可判定' }
  };
  function stateIcon(s, label) {
    const d = STATE_IC[s] || STATE_IC.na;
    const tx = label === false ? '' : `<span class="si-t">${label || d.t}</span>`;
    return `<span class="state-ic" style="color:${d.c}">${d.i ? icon(d.i) : '—'}${tx}</span>`;
  }

  /* ---- 面板 ---- */
  function panel(o) {
    const extra = o.extra || '';
    const sub = o.sub ? `<span class="sub">${o.sub}</span>` : '';
    const head = o.title === false ? '' :
      `<div class="ph"><h3>${o.title}</h3>${sub}<span class="spacer"></span>${extra}</div>`;
    const cls = ['panel', o.variant ? 'panel-' + o.variant : '', o.density ? 'density-' + o.density : '', o.className || ''].filter(Boolean).join(' ');
    return `<section class="${cls}" style="${o.style || ''}">${head}
      <div class="pb ${o.nopad ? 'nopad' : ''}" ${o.bodyStyle ? `style="${o.bodyStyle}"` : ''}>${o.body || ''}</div></section>`;
  }

  /* ---- 详情头图 ----
     只承载标题、编号、状态与摘要；主题背景由 body[data-theme] 的 CSS 变量提供，
     不把装饰图当业务信息源。 */
  function detailHero(o) {
    o = o || {};
    const variant = ['compact', 'micro'].includes(o.variant) ? o.variant : 'auto';
    const tags = Array.isArray(o.tags) ? o.tags.join('') : (o.tags || '');
    const meta = Array.isArray(o.meta) ? o.meta.map(x => {
      if (Array.isArray(x)) return `<span><b>${x[0]}</b>${x[1]}</span>`;
      return `<span>${x}</span>`;
    }).join('') : (o.meta || '');
    const summary = Array.isArray(o.summary) ? o.summary.map(x => {
      const item = Array.isArray(x) ? { label: x[0], value: x[1] } : x;
      return `<span class="detail-hero-stat ${item.tone ? 'is-' + item.tone : ''}"><small>${item.label}</small><b>${item.value}</b></span>`;
    }).join('') : (o.summary || '');
    return `<div class="detail-hero detail-hero-${variant}">
      <div class="detail-hero-inner">
        <div class="detail-hero-icon">${icon(o.icon || 'file')}</div>
        <div class="detail-hero-copy">
          ${o.subtitle ? `<div class="detail-hero-eyebrow">${o.subtitle}</div>` : ''}
          <div class="detail-hero-title" title="${String(o.title || '详情').replace(/"/g, '&quot;')}">${o.title || '详情'}</div>
          ${o.id ? `<div class="detail-hero-id mono" title="${String(o.id).replace(/"/g, '&quot;')}">${o.id}</div>` : ''}
        </div>
        <div class="detail-hero-side">
          ${o.actions ? `<div class="detail-hero-actions">${o.actions}</div>` : ''}
          ${tags ? `<div class="detail-hero-tags">${tags}</div>` : ''}
          ${summary ? `<div class="detail-hero-summary">${summary}</div>` : ''}
          ${meta ? `<div class="detail-hero-meta">${meta}</div>` : ''}
        </div>
      </div>
    </div>`;
  }

  /* ---- KPI ---- */
  // 保留 UI.KC 公共契约，经典脚本加载早于 CSS，因此按需读取 token。
  const KC = {};
  ['blue','cyan','green','amber','orange','red','purple','pink'].forEach(name => {
    Object.defineProperty(KC, name, { enumerable: true, get: () => getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim() });
  });
  function kpis(list, opts) {
    opts = opts || {};
    const wrapCls = ['kpis', opts.variant ? 'kpis-' + opts.variant : '', opts.density ? 'density-' + opts.density : '', opts.className || ''].filter(Boolean).join(' ');
    return `<div class="${wrapCls}">` + list.map(k => {
      // k.attr（如 data-kpi="非法"）为 opt-in 可点击卡：加手型/焦点态；k.active 标当前激活。
      // 不传时输出与既有调用方完全一致，其余页面零影响。
      const click = k.attr ? ` ${k.attr} tabindex="0" role="button"` : '';
      return `<div class="kpi kpi-${k.color || 'blue'} ${k.className || ''}${k.attr ? ' is-clickable' : ''}${k.active ? ' is-active' : ''}"${click}${k.desc ? ` title="${String(k.desc).replace(/<[^>]*>/g, '').replace(/"/g, '&quot;')}"` : ''}>
        <div class="ic">${icon(k.icon || 'chart')}</div>
        <div class="tx"><div class="lb" title="${String(k.label).replace(/"/g, '&quot;')}">${k.label}</div>
          <div class="vl">${k.value}${k.unit ? `<span class="unit">${k.unit}</span>` : ''}</div>${k.caption ? `<div class="dt">${k.caption}</div>` : ''}</div></div>`;
    }).join('') + `</div>`;
  }

  /* ---- 表格 ---- */
  /* cols: [{k,t,align,render(row,i)}]  opts:{page,size,total,rowId,onRow,activeId,maxH}
     列宽统一交给浏览器按单元格内容计算，调用方遗留的 w 仅作兼容输入、不再输出。 */
  function table(cols, rows, opts) {
    opts = opts || {};
    // opts.checkbox: (row)=>id|null —— 返回 id 则该行可勾选(用于批量处置/批量归档)
    const ckHead = opts.checkbox ? `<th class="ck"><input type="checkbox" data-ckall aria-label="全选"></th>` : '';
    const head = ckHead + cols.map(c => `<th class="${c.priority ? 'col-' + c.priority : ''}" style="${c.align ? 'text-align:' + c.align : ''}">${c.t}</th>`).join('');
    const body = rows.length ? rows.map((r, i) => {
      const id = opts.rowId ? opts.rowId(r) : '';
      const ckId = opts.checkbox ? opts.checkbox(r) : null;
      const ckCell = opts.checkbox ? `<td class="ck">${ckId ? `<input type="checkbox" data-ck="${ckId}" aria-label="选择本行">` : ''}</td>` : '';
      return `<tr data-row="${id}" tabindex="0" class="${opts.activeId && id === opts.activeId ? 'on' : ''}">` + ckCell + cols.map(c => {
        const v = c.render ? c.render(r, i) : (r[c.k] == null ? '—' : r[c.k]);
        return `<td class="${[c.cls || '', c.priority ? 'col-' + c.priority : ''].filter(Boolean).join(' ')}" style="${c.align ? 'text-align:' + c.align : ''}">${v}</td>`;
      }).join('') + '</tr>';
    }).join('') : `<tr><td colspan="${cols.length + (opts.checkbox ? 1 : 0)}"><div class="empty">暂无数据</div></td></tr>`;
    const tableCls = ['tb', opts.density ? 'density-' + opts.density : '', opts.className || ''].filter(Boolean).join(' ');
    return `<div class="scroll table-scroll table-shell" style="${opts.maxH ? 'max-height:' + opts.maxH + ';' : ''}flex:1">
      <table class="${tableCls}"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  /* 列表主次信息统一排版。secondary 可为空，opts:{icon,mono,tone,title}。 */
  function cell(primary, secondary, opts) {
    opts = opts || {};
    const cls = ['cell-stack', opts.mono ? 'cell-mono' : '', opts.tone ? 'cell-' + opts.tone : ''].filter(Boolean).join(' ');
    const title = opts.title ? ` title="${String(opts.title).replace(/"/g, '&quot;')}"` : '';
    return `<div class="${cls}"${title}>${opts.icon ? `<span class="cell-icon">${icon(opts.icon)}</span>` : ''}<span class="cell-copy"><span class="cell-main">${primary == null ? '—' : primary}</span>${secondary == null || secondary === '' ? '' : `<span class="cell-sub">${secondary}</span>`}</span></div>`;
  }
  /* 行选中态切换:只改 class,不重建列表 —— 修复"点击行后列表滚回顶部" */
  function selectRow(root, id, attr) {
    root.querySelectorAll('[' + (attr || 'data-row') + ']').forEach(tr =>
      tr.classList.toggle('on', tr.getAttribute(attr || 'data-row') === id));
  }

  /* 读取容器内勾选的 id 列表;并让"全选"联动 */
  function checked(root) { return [...root.querySelectorAll('[data-ck]:checked')].map(x => x.dataset.ck); }
  function bindCheckAll(root) {
    on(root, '[data-ckall]', 'change', (e, el) => {
      root.querySelectorAll('[data-ck]').forEach(c => c.checked = el.checked);
    });
    on(root, '[data-ck]', 'click', e => e.stopPropagation());   // 勾选不触发行点击
  }
  /* 跨页上下文:goto('legality', {target:id}) → 目标页 render 时用 consume 取出并选中 */
  function goto(page, ctx) {
    if (ctx) sessionStorage.setItem('goto.' + page, JSON.stringify(ctx));
    location.hash = '#/' + page;
  }
  function consume(page) {
    const k = 'goto.' + page, v = sessionStorage.getItem(k);
    if (!v) return null;
    sessionStorage.removeItem(k);
    try { return JSON.parse(v); } catch (e) { return null; }
  }

  function pager(o) {   // {total,page,size,id}
    const pages = Math.max(1, Math.ceil(o.total / o.size));
    const cur = o.page, out = [];
    // 只有真实页码才高亮为当前页：前后箭头即便与当前页同号也不能标成 on
    const btn = (n, lb, dis) => `<span class="pg ${lb == null && n === cur ? 'on' : ''}${dis ? ' dis' : ''}" data-pg="${dis ? '' : n}">${lb == null ? n : lb}</span>`;
    out.push(btn(Math.max(1, cur - 1), '‹', cur === 1));
    const set = new Set([1, 2, pages, pages - 1, cur, cur - 1, cur + 1]);
    let last = 0;
    [...set].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b).forEach(n => {
      if (n - last > 1) out.push(`<span style="color:var(--txt-3)">…</span>`);
      out.push(btn(n)); last = n;
    });
    out.push(btn(Math.min(pages, cur + 1), '›', cur === pages));
    return `<div class="pager" data-pager="${o.id || ''}">
      <span>共 ${num(o.total)} 条</span>
      <select class="sel" data-size style="height:26px">${[10, 20, 50].map(s => `<option ${s === o.size ? 'selected' : ''}>${s}条/页</option>`).join('')}</select>
      ${out.join('')}
      <span>共 ${pages} 页</span></div>`;
  }

  /* ---- kv / 分区 ---- */
  function kv(list, opts) {
    opts = opts || {};
    const cls = ['kv', opts.columns ? 'kv-cols-' + opts.columns : '', opts.density ? 'density-' + opts.density : '', opts.surface ? 'kv-surface' : ''].filter(Boolean).join(' ');
    return `<dl class="${cls}">` + list.map((row, i) => {
      const k = row[0], v = row[1], io = row[2] || {};
      const em = io.emphasis || (Array.isArray(opts.emphasis) && opts.emphasis.includes(k));
      return `<dt class="${em ? 'is-emphasis' : ''}">${k}</dt><dd class="${em ? 'is-emphasis' : ''} ${io.tone ? 'is-' + io.tone : ''}">${v == null ? '—' : v}</dd>`;
    }).join('') + `</dl>`;
  }
  function sect(t, b, opts) {
    opts = opts || {};
    if (!Object.keys(opts).length) return `<div class="sect"><h4>${t}</h4>${b}</div>`;
    const cls = ['sect', 'detail-sect', opts.tone ? 'tone-' + opts.tone : '', opts.className || ''].filter(Boolean).join(' ');
    const head = `<span class="sect-head">${opts.icon ? `<span class="sect-icon">${icon(opts.icon)}</span>` : ''}<span class="sect-title">${t}</span>${opts.badge ? `<span class="sect-badge">${opts.badge}</span>` : ''}</span>`;
    return opts.collapsible
      ? `<details class="${cls}" ${opts.open === false ? '' : 'open'}><summary>${head}</summary><div class="sect-body">${b}</div></details>`
      : `<div class="${cls}">${head}<div class="sect-body">${b}</div></div>`;
  }

  function metricStrip(items, opts) {
    opts = opts || {};
    const cls = ['metric-strip', opts.compact ? 'is-compact' : '', opts.className || ''].filter(Boolean).join(' ');
    return `<div class="${cls}">` + items.map(raw => {
      const x = Array.isArray(raw) ? { label: raw[0], value: raw[1], sub: raw[2] } : raw;
      return `<div class="metric-item ${x.tone ? 'is-' + x.tone : ''}">${x.icon ? `<span class="metric-icon">${icon(x.icon)}</span>` : ''}<span class="metric-copy"><small>${x.label}</small><b>${x.value == null ? '—' : x.value}${x.unit ? `<em>${x.unit}</em>` : ''}</b>${x.sub ? `<span>${x.sub}</span>` : ''}</span></div>`;
    }).join('') + `</div>`;
  }

  const detailActions = (content, opts) => {
    opts = opts || {};
    return `<div class="detail-actions ${opts.sticky === false ? '' : 'is-sticky'} ${opts.className || ''}">${content}</div>`;
  };

  function codeBlock(title, value, opts) {
    opts = opts || {};
    const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="code-viewer"><div class="code-viewer-head"><span>${title || '代码'}</span><span class="spacer"></span>${opts.language ? `<small>${opts.language}</small>` : ''}<button class="icon-btn" data-copy-code title="复制">${icon('copy')}</button></div><pre style="${opts.maxH ? 'max-height:' + opts.maxH : ''}"><code>${esc(value)}</code></pre></div>`;
  }

  /* ---- 步骤 / 时间轴 ---- */
  /* [{n,t,done,act,applicable}]
     applicable===false 表示**本案流程不包含该环节**（如未涉及反制的案件）。
     它必须和"尚未执行"在视觉上分开：两者 done 都是 false，
     若共用待处理样式，界面就等于宣称"这一步还欠着"——而它永远不会做。
     未传 applicable 时按 true 处理（旧调用方行为不变）。 */
  function steps(list) {
    return `<div class="steps">` + list.map((s, i) => {
      const na = s.applicable === false;
      return `<div class="st ${s.done ? 'done' : ''} ${s.act ? 'act' : ''} ${na ? 'na' : ''}">
        <div class="c">${na ? '—' : s.done ? icon('check') : String(i + 1).padStart(2, '0')}</div>
        <div class="n">${s.n}</div><div class="t">${s.t || ''}</div></div>`;
    }).join('') + `</div>`;
  }
  function timeline(list) {  // [{time,label,desc,color}]
    return `<div class="tl">` + list.map(n =>
      `<div class="n"><div class="tm" style="color:${n.color}">${n.time}</div>
        <div class="pt" style="border-color:${n.color};box-shadow:0 0 0 3px ${n.color}33"></div>
        <div class="lb">${n.label}</div><div class="ds">${n.desc || ''}</div></div>`).join('') + `</div>`;
  }

  /* ---- 弹窗 / 提示 ---- */
  let modalEl = null;
  function modal(o) {
    closeModal();
    modalEl = document.createElement('div');
    modalEl.className = 'mask';
    modalEl.innerHTML = `<div class="modal" style="${o.width ? 'width:' + o.width : ''}">
      <div class="mh">${o.title}<button class="icon-btn x" type="button" data-close aria-label="关闭">${icon('close')}</button></div>
      <div class="mb">${o.body}</div>
      ${o.footer === false ? '' : `<div class="mf">${o.footer || '<button class="btn" data-close>关闭</button>'}</div>`}</div>`;
    document.body.appendChild(modalEl);
    modalEl.addEventListener('click', e => {
      if (e.target === modalEl || e.target.closest('[data-close]')) closeModal();
      const a = e.target.closest('[data-act]');
      if (a && o.on && o.on[a.dataset.act]) o.on[a.dataset.act](modalEl, a);
    });
    if (o.mounted) o.mounted(modalEl);
    return modalEl;
  }
  function closeModal() { if (modalEl) { modalEl.remove(); modalEl = null; } }
  function toast(msg, type) {
    const t = document.createElement('div');
    t.className = 'toast ' + (type || '');
    t.innerHTML = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.style.transition = '.3s'; t.style.opacity = 0; setTimeout(() => t.remove(), 300); }, 2600);
  }

  /* ---- 工具条 ---- */
  function field(label, inner) { return `<div class="field"><label>${label}</label>${inner}</div>`; }
  function select(name, opts, val) {
    return `<select class="sel" data-f="${name}">` +
      opts.map(o => { const v = typeof o === 'string' ? o : o.v; const t = typeof o === 'string' ? o : o.t; return `<option value="${v}" ${v === val ? 'selected' : ''}>${t}</option>`; }).join('') + `</select>`;
  }
  const input = (name, ph, val) => `<input class="ip" data-f="${name}" placeholder="${ph || ''}" value="${val || ''}">`;

  /* ---- 进度条列表 ---- */
  function bars(list) {  // [{name,value,max,color,tx}]
    return `<div class="lst">` + list.map(b => `<div class="li">
      <div class="t"><span>${b.name}</span><span class="mono" style="color:var(--txt)">${b.tx != null ? b.tx : num(b.value)}</span></div>
      <div class="bar"><i style="width:${Math.min(100, b.value / (b.max || 100) * 100).toFixed(1)}%;${b.color ? 'background:' + b.color : ''}"></i></div>
    </div>`).join('') + `</div>`;
  }

  /* ---- 事件委托小工具 ---- */
  /* 事件委托。
     注意：不能用 root.contains(t) 做过滤 —— 同一次点击若先被"选中行"的处理器重绘了列表，
     被点的节点已从 DOM 移除，contains() 会变成 false，导致行内"编辑/删除/测试"等操作被静默吞掉。
     这里改为：只要事件是从 root 上冒泡上来的就认，已脱离文档的节点同样放行。 */
  function on(root, sel, ev, fn) {
    root.addEventListener(ev, e => {
      const t = e.target.closest(sel);
      if (t && (root.contains(t) || !t.isConnected)) fn(e, t);
    });
  }

  /* A4:类别来源标签 —— 区分「设备按 objectType 上报」与「光电算法 A06 推断」 */
  /* source_confidence 是 0~1 小数（Target Schema V1），展示统一走这里，
     避免各页各写一份「>1 当百分数、<=1 当小数」的兼容判断。
     注意与上面的 pct(a, b) 区分：那个是「a 占 b 的比例」，这个是「把置信度小数格式化」。 */
  function confPct(v) { return v == null ? '—' : Math.round(v <= 1 ? v * 100 : v) + '%'; }

  /* ---- COM-03 参数注册表 ----
     阈值参数保留在各业务页就地配置（调阈值要立刻看命中效果），
     这里只做**总览与版本审计**：页面把自己的参数块注册进来，总览页读的是同一个对象引用，
     不是副本 —— 一旦复制，总览显示的就会是"注册那一刻的值"而不是当前值。 */
  const _params = [];
  function regParams(g) {
    const i = _params.findIndex(x => x.key === g.key);
    if (i >= 0) _params[i] = g; else _params.push(g);   // 页面重挂载时覆盖而不是叠加
    return g;
  }
  function paramGroups() { return _params.slice(); }

  /* 机型必须连同「凭什么知道」一起显示：射频只到系列级、雷达根本给不出。
     单看一个型号名字是分不出「解出来的」还是「报备写的」的。 */
  const MODEL_SRC_CLR = { '协议破解解析': '#79e5a5', 'RemoteID 广播': '#79e5a5', '飞行计划报备': '#8fbaff', '射频特征匹配': '#c9a2ff' };
  const MODEL_SRC_ABBR = { '协议破解解析': '解析', 'RemoteID 广播': '广播', '飞行计划报备': '报备', '射频特征匹配': '射频' };
  const MODEL_SRC_WHY = {
    '协议破解解析': '协议破解设备解出的具体型号', 'RemoteID 广播': 'RemoteID 广播中的具体型号',
    '飞行计划报备': '型号取自报备信息，非探测识别所得', '射频特征匹配': '射频特征只能匹配到系列级，是线索不是识别结果'
  };
  /* short=true 用于表格：列宽有限，只给一个两字来源标记 + tooltip；
     详情面板用完整标签。表头装饰宁可零宽度也不要顶宽表格。 */
  function modelTag(model, src, short) {
    if (!model || model === '未识别')
      return `<span style="color:var(--txt-3)" title="该目标仅由雷达/5G-A 通感发现，设备不具备机型识别能力">未识别</span>`
        + (short ? '' : ` <span class="tag t-gray">无型号来源</span>`);
    const c = MODEL_SRC_CLR[src] || 'var(--txt-3)';
    const txt = short ? (MODEL_SRC_ABBR[src] || src) : src;
    return `<span>${model}</span>` + (src ? ` <span class="tag" style="color:${c};border-color:${c}55;background:${c}18"
      title="${MODEL_SRC_WHY[src] || ''}">${txt}</span>` : '');
  }

  function srcTag(kind, conf) {
    if (kind === 'device') return `<span class="tag t-cyan" title="设备按协议 objectType 字段上报">设备上报</span>`;
    if (kind === 'ai') return `<span class="tag t-purple" title="协议中无此类型，由光电分类算法 A06 推断（B档：功能性实现）">算法推断${conf ? ' ' + conf + '%' : ''}</span>`;
    return `<span class="tag t-gray">未识别</span>`;
  }


  /* ---- 合法性结论与判定依据（多页共用一份渲染）----
     各页各写一份的话，一处改了措辞、另一处没改，同一个目标在两页读起来像两个结论。
     只读 target 上的客观事实，不做任何判定 —— 判定归 mock.js 的 deriveLegality。 */
  function legalBasis(t) {
    const f = t.facts || {};
    const zone = (f.zoneHits || [])[0];
    const dims = f.planMatchDims || {};
    return [
      {
        k: '身份', na: dims['无人机身份'] == null, bad: dims['无人机身份'] === false,
        ok: '实名信息与报备一致', no: '未获取有效实名信息',
        un: '未取得可比对的实名 SN（需协议破解 / RemoteID 设备），本项无判据'
      },
      {
        k: '计划', na: false, bad: f.planMatch === '未命中',
        ok: '已匹配审批飞行计划（' + (f.planMatch || '—') + '）', no: '未匹配到审批飞行计划'
      },
      {
        k: '空域', na: false, bad: !!(f.inNoFlyZone || f.overZoneHeight || f.overZoneTime),
        ok: '未进入禁止空间、未超限高',
        no: f.inNoFlyZone ? '进入禁飞区' + (zone ? '：' + zone.name : '')
          : f.overZoneHeight ? '超出空域限高' + (zone && zone.limit ? '（限 ' + zone.limit + ' m，实测 ' + zone.h + ' m）' : '')
            : '超出空域管制时段'
      },
      {
        k: '时间', na: false, bad: !!(f.night || f.overPlanTime),
        ok: '在允许飞行时段内', no: f.night ? '夜间时段飞行' : '超出计划批准时段'
      }
    ];
  }
  function basisHtml(t) {
    return `<div class="basis">` + legalBasis(t).map(x => `
      <div class="b ${x.na ? 'na' : x.bad ? 'bad' : ''}">
        <div class="bi">${stateIcon(x.na ? 'na' : x.bad ? 'fail' : 'pass', false)}</div>
        <div class="bt"><b>${x.k}</b><span>${x.na ? (x.un || '本项无判据') : x.bad ? x.no : x.ok}</span></div>
      </div>`).join('') + `</div>`;
  }
  /* extra: 结论右侧的操作区（各页自定） */
  function verdictHtml(t, extra) {
    if (t.type !== '无人机') {
      return `<div class="verdict warn"><div class="vi">${icon('alert')}</div><div class="vt"><h2>不适用</h2>
        <p>${t.type}属空中异物，不具备飞行计划与实名身份，不进入 C01/C02/C03 合法性判定，
        按《设计方案 §4.2》走空间安全风险线：评估风险 → 通知责任方 → 驱离 → 记录结果。</p></div>
        ${extra ? `<div class="va">${extra}</div>` : ''}</div>`;
    }
    const bad = t.legal === '非法', good = t.legal === '合法';
    const head = bad ? '判定为非法飞行' : good ? '判定为合法飞行' : '判定为' + t.legal;
    const sub = bad
      ? `${(t.violation_reasons || []).join('、')}。`
      : good ? '四项判定依据全部通过。' : '存在未证实或无判据的判定项，需人工进一步核实。';
    return `<div class="verdict ${bad ? '' : good ? 'ok' : 'warn'}">
      <div class="vi">${bad ? icon('warning') : good ? icon('check') : icon('alert')}</div>
      <div class="vt"><h2>${head}</h2><p>${sub}</p></div>
      ${extra ? `<div class="va">${extra}</div>` : ''}</div>`;
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-copy-code]');
    if (!b) return;
    const code = b.closest('.code-viewer') && b.closest('.code-viewer').querySelector('code');
    if (!code) return;
    const done = () => toast('内容已复制', 'ok');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code.textContent).then(done).catch(() => toast('复制失败，请手动选择', 'err'));
    else toast('当前环境不支持自动复制', 'err');
  });

  g.UI = {
    icon, deviceMeta, deviceIcon, num, pct, money, delta, tag, risk, legal, dotState, stateIcon, panel, detailHero, kpis, table, cell, pager,
    checked, bindCheckAll, goto, consume, selectRow, srcTag, confPct, modelTag, regParams, paramGroups,
    kv, sect, metricStrip, detailActions, codeBlock, steps, timeline, modal, closeModal, toast, field, select, input, bars, on, KC,
    legalBasis, basisHtml, verdictHtml
  };
})(window);
