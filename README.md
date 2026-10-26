# Pet Animation Standalone

抽取自 OpenPets 的宠物和动画实现，独立可用的精灵图动画系统。

## 核心概念

- reaction -> 动画状态映射：agent 状态映射到对应精灵图动画
- CSS 精灵动画：基于 background-position + steps() 实现逐帧动画
- 可配置：支持 reaction 映射覆盖、等待动画时长等
- 多语言：支持 reaction 气泡文案的本地化

## 核心模块

| 文件 | 说明 |
|---|---|
| reaction-animation-mapping.ts | 动画状态定义、reaction 映射、精灵图布局、状态解析 |
| reaction-messages.ts | 气泡文案池和选择逻辑 |
| pet-window-styles.ts | 生成动画 CSS 样式 |
| pet-window-render.ts | 生成完整的 HTML 渲染页面 |
| built-in-pet.ts | 内置宠物配置 |
| codex-pets-core.ts | 精灵图布局和验证逻辑 |

## 使用示例

见 src/demo.ts
