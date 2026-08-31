#!/bin/bash
# 字节级等价校验：dongying-vue 携带的 legacy 文件必须与 dongying-demo 逐字节一致。
# 任何差异即失败 —— 1:1 还原靠 diff 机械证明，不靠人眼。
cd "$(dirname "$0")/.." || exit 1
SRC="../dongying-demo/assets"
DST="public/assets"
fail=0
for f in mock ui charts geo map video case search bigscreen; do
  cmp -s "$SRC/js/$f.js" "$DST/js/$f.js" || { echo "DIFF: js/$f.js"; fail=1; }
done
cmp -s "../dongying-demo/bigscreen.html" "public/bigscreen.html" || { echo "DIFF: bigscreen.html"; fail=1; }
cmp -s "$SRC/css/bigscreen.css" "$DST/css/bigscreen.css" || { echo "DIFF: css/bigscreen.css"; fail=1; }
for f in "$SRC"/js/pages/*.js; do
  b=$(basename "$f")
  cmp -s "$f" "$DST/js/pages/$b" || { echo "DIFF: js/pages/$b"; fail=1; }
done
cmp -s "$SRC/js/vendor/echarts.min.js" "$DST/js/vendor/echarts.min.js" || { echo "DIFF: vendor/echarts.min.js"; fail=1; }
cmp -s "$SRC/css/app.css" "$DST/css/app.css" || { echo "DIFF: css/app.css"; fail=1; }
diff -rq "$SRC/img" "$DST/img" >/dev/null 2>&1 || { echo "DIFF: img/"; fail=1; }
if [ $fail -eq 0 ]; then
  echo "PARITY OK: legacy 文件与 dongying-demo 逐字节一致"
else
  exit 1
fi
