# UI 技术债（范围：`public/*`）

> 目标：逐步减少硬编码样式与分散的“例外规则”，让 UI 可持续迭代。

## 已完成

- 引入 `design-tokens/c2p.tokens.json` → 生成 `public/tokens.css`
- 样式迁移为语义变量驱动（`--bg`/`--surface`/`--text` 等）
- 引入外观偏好（主题/高对比/减少动效/降低透明度）

## 待改进（不阻塞功能）

- 触控目标尺寸已提升到 44px 基线，但仍需持续回归验证不同屏幕与字体缩放场景
- `public/reset-cache.html` 仍存在硬编码颜色与未接入 tokens 的样式
- 仍有少量阴影/透明度为硬编码值（属于视觉细节，可后续通过 tokens 统一）
