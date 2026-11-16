# 展品图集示范素材包 demo-pack

本目录由 `npm run pack` 整体生成，可直接在展品纹理图集工作室（图形入口 `index.html`）
通过「载入示范素材包」按钮加载，也可用 `npm run rebuild-pack` 离线重建并核验。

## 目录
- `sources/`：自制展品来源 PNG 与 `sources.json`（配方、调色板、每个素材的检验目标）
- `atlas/`：守护式逐级贴图 `guarded_p0_l*.png`、反例 `naive_p0_l*.png`、`manifest.json`
- `scenes/`：近景 L0 与远景 L2 墙渲染（守护链与整页滤波反例各一张）
- `mip-edges/`：每个图块 L0/L1/L2 核心+扩色环的放大条带，左守护右反例
- `pack-params.json`：打包参数（padding/页上限/预算/旋转/场景），重建时逐字读回
- `evidence.json`：mip 边缘与采样颜色的逐探针 RGBA 数值及判定

## 打包参数
- padding: 12px
- pageLimit: 1024px
- budget: 16 MiB
- allowRotation: true
- safeLod: L3

## 判定约定（阈值见 evidence.json）
- 守护链内部不透明探针必须与图块自身补丁重采样结果一致（RGB Δ ≤ 2）
- 整页滤波反例在边缘探针上的预乘色差 > 8 即标记为采样污染
- 本包实测：污染边缘探针 74 个，守护链失败探针 0 个

图形入口见仓库根目录 `docs/usage.md`；命令行仅用于辅助重建与核验。
