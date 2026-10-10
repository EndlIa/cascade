import type { Theme } from '../core/gl/theme.ts';

export const ALARM_THEME: Theme = {
  classAxisLabel: '报警',
  modifierAxisLabel: '状态',
  background: [0.04, 0.06, 0.10],
  classes: [
    { label: '报警', color: [1, 0.26, 0.2], size: 30 },
    { label: '报警', color: [1, 0.26, 0.2], size: 30 },
    { label: '报警', color: [1, 0.26, 0.2], size: 30 },
    { label: '报警', color: [1, 0.26, 0.2], size: 30 },
    { label: '报警', color: [1, 0.26, 0.2], size: 30 },
  ],
  modifiers: [
    { label: '正常', tint: [1, 0.26, 0.2], amount: 0, scale: 1 },
    { label: '检修', tint: [1, 0.26, 0.2], amount: 0, scale: 1 },
    { label: '报警', tint: [1, 0.26, 0.2], amount: 0, scale: 1 },
  ],
};

export const SELECTION_THEME: Theme = {
  classAxisLabel: '选中',
  modifierAxisLabel: '状态',
  background: [0.04, 0.06, 0.10],
  classes: [
    { label: '选中', color: [0.55, 0.95, 1], size: 6 },
    { label: '选中', color: [0.55, 0.95, 1], size: 6 },
    { label: '选中', color: [0.55, 0.95, 1], size: 6 },
    { label: '选中', color: [0.55, 0.95, 1], size: 6 },
    { label: '选中', color: [0.55, 0.95, 1], size: 6 },
  ],
  modifiers: [
    { label: '正常', tint: [0.55, 0.95, 1], amount: 0, scale: 1 },
    { label: '检修', tint: [0.55, 0.95, 1], amount: 0, scale: 1 },
    { label: '报警', tint: [1, 0.24, 0.18], amount: 0.92, scale: 1.35 },
  ],
};

export const CAMPUS_THEME: Theme = {
  classAxisLabel: '功能分区',
  modifierAxisLabel: '运行状态',
  background: [0.04, 0.06, 0.10],
  classes: [
    { label: '反应装置区', color: [0.10, 0.42, 0.85], size: 2.4 },
    { label: '储罐区', color: [0.48, 0.28, 0.78], size: 2.2 },
    { label: '公用工程区', color: [0.05, 0.52, 0.46], size: 2.2 },
    { label: '装卸车区', color: [0.78, 0.48, 0.06], size: 2.5 },
    { label: '办公与门禁', color: [0.36, 0.42, 0.52], size: 2.1 },
  ],
  modifiers: [
    { label: '正常', tint: [0.5, 0.5, 0.5], amount: 0, scale: 1 },
    { label: '检修', tint: [0.55, 0.58, 0.62], amount: 0.6, scale: 0.8 },
    { label: '报警', tint: [0.92, 0.12, 0.10], amount: 0.95, scale: 1.6 },
  ],
};
