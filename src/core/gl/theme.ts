
export interface ThemeClass {
  label: string;
  color: [number, number, number];
  size: number;
}

export interface ThemeModifier {
  label: string;
  tint: [number, number, number];
  amount: number;
  scale: number;
}

export interface Theme {
  classes: ThemeClass[];
  modifiers: ThemeModifier[];
  classAxisLabel: string;
  modifierAxisLabel: string;
  background: [number, number, number];
}

const FALLBACK_COLOR: [number, number, number] = [0.45, 0.45, 0.48];
const FALLBACK_SIZE = 4;
const FALLBACK_AMOUNT = 0;
const FALLBACK_SCALE = 1;

function emitLookup<T> (
  name: string,
  returnType: string,
  table: readonly T[],
  literal: (item: T) => string,
  fallback: string,
): string {
  const lines = [`${returnType} ${name} (float i) {`];
  for (let k = 0; k < table.length; k++) {
    const head = k === 0 ? '  if' : '  else if';
    lines.push(`${head} (i < ${(k + 0.5).toFixed(1)}) return ${literal(table[k])};`);
  }
  lines.push(`  return ${fallback};`);
  lines.push('}');
  return lines.join('\n');
}

function glslVec3 (c: readonly number[]): string {
  return `vec3(${c.map((v) => v.toFixed(6)).join(', ')})`;
}

function glslFloat (v: number): string {
  return v.toFixed(6);
}

export function themeGlsl (theme: Theme): string {
  return [
    '// 以下五个函数由主题生成 —— 不要手改，改主题表。',
    emitLookup('tClassColor', 'vec3', theme.classes, (c) => glslVec3(c.color), glslVec3(FALLBACK_COLOR)),
    emitLookup('tClassSize', 'float', theme.classes, (c) => glslFloat(c.size), glslFloat(FALLBACK_SIZE)),
    emitLookup('tModifierTint', 'vec3', theme.modifiers, (m) => glslVec3(m.tint), glslVec3(FALLBACK_COLOR)),
    emitLookup('tModifierAmount', 'float', theme.modifiers, (m) => glslFloat(m.amount), glslFloat(FALLBACK_AMOUNT)),
    emitLookup('tModifierScale', 'float', theme.modifiers, (m) => glslFloat(m.scale), glslFloat(FALLBACK_SCALE)),
  ].join('\n\n');
}

export const COMPOSE_GLSL = `
  vec3 tComposeColor (float a, float b) {
    return mix(tClassColor(a), tModifierTint(b), tModifierAmount(b));
  }
  float tComposeSize (float a, float b) {
    return tClassSize(a) * tModifierScale(b);
  }
`;

export interface LegendItem {
  label: string;
  css: string;
  rgb: [number, number, number];
}

export interface Legend {
  classAxisLabel: string;
  modifierAxisLabel: string;
  classes: LegendItem[];
  modifiers: LegendItem[];
}

export function themeLegend (theme: Theme): Legend {
  const toItem = (label: string, rgb: [number, number, number]): LegendItem => ({
    label,
    rgb,
    css: `rgb(${rgb.map((v) => Math.round(v * 255)).join(' ')})`,
  });

  return {
    classAxisLabel: theme.classAxisLabel,
    modifierAxisLabel: theme.modifierAxisLabel,
    classes: theme.classes.map((c) => toItem(c.label, c.color)),
    modifiers: theme.modifiers.map((m) => {
      const mixed: [number, number, number] = [
        FALLBACK_COLOR[0] + (m.tint[0] - FALLBACK_COLOR[0]) * m.amount,
        FALLBACK_COLOR[1] + (m.tint[1] - FALLBACK_COLOR[1]) * m.amount,
        FALLBACK_COLOR[2] + (m.tint[2] - FALLBACK_COLOR[2]) * m.amount,
      ];
      return toItem(m.label, mixed);
    }),
  };
}
