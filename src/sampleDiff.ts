// A hardcoded diff model shown when prequel is pointed at something that isn't
// a git repo, so the UI still demonstrates the render pipeline and theming.

import type { Diff } from './types';

export const sampleDiff: Diff = {
  base: 'main',
  head: 'feature/pricing-rules',
  files: [
    {
      id: 'a1',
      oldPath: 'src/pricing/calculator.ts',
      newPath: 'src/pricing/calculator.ts',
      status: 'modified',
      isBinary: false,
      language: 'typescript',
      additions: 6,
      deletions: 2,
      hunks: [
        {
          header: '@@ -12,7 +12,11 @@ export class PriceCalculator {',
          sectionHeading: 'export class PriceCalculator {',
          oldStart: 12,
          newStart: 12,
          lines: [
            { type: 'context', oldNumber: 12, newNumber: 12, content: '  calculate(order: Order): Money {' },
            { type: 'context', oldNumber: 13, newNumber: 13, content: '    const subtotal = this.subtotal(order);' },
            { type: 'del', oldNumber: 14, newNumber: null, content: '    const tax = subtotal * 0.1;' },
            { type: 'del', oldNumber: 15, newNumber: null, content: '    return subtotal + tax;' },
            { type: 'add', oldNumber: null, newNumber: 14, content: '    const rate = this.rateFor(order.region);' },
            { type: 'add', oldNumber: null, newNumber: 15, content: '    const tax = subtotal * rate;' },
            { type: 'add', oldNumber: null, newNumber: 16, content: '    const rounded = this.round(subtotal + tax);' },
            { type: 'add', oldNumber: null, newNumber: 17, content: '    return rounded;' },
            { type: 'context', oldNumber: 16, newNumber: 18, content: '  }' },
            { type: 'context', oldNumber: 17, newNumber: 19, content: '' },
            { type: 'context', oldNumber: 18, newNumber: 20, content: '  private subtotal(order: Order): number {' },
          ],
        },
      ],
    },
    {
      id: 'b2',
      oldPath: 'src/pricing/regions.ts',
      newPath: 'src/pricing/regions.ts',
      status: 'added',
      isBinary: false,
      language: 'typescript',
      additions: 5,
      deletions: 0,
      hunks: [
        {
          header: '@@ -0,0 +1,5 @@',
          sectionHeading: '',
          oldStart: 0,
          newStart: 1,
          lines: [
            { type: 'add', oldNumber: null, newNumber: 1, content: 'export const REGION_RATES: Record<string, number> = {' },
            { type: 'add', oldNumber: null, newNumber: 2, content: '  US: 0.0725,' },
            { type: 'add', oldNumber: null, newNumber: 3, content: '  EU: 0.20,' },
            { type: 'add', oldNumber: null, newNumber: 4, content: '  CA: 0.13,' },
            { type: 'add', oldNumber: null, newNumber: 5, content: '};' },
          ],
        },
      ],
    },
    {
      id: 'c3',
      oldPath: 'docs/PRICING.md',
      newPath: 'docs/pricing.md',
      status: 'renamed',
      isBinary: false,
      language: 'markdown',
      additions: 1,
      deletions: 1,
      hunks: [
        {
          header: '@@ -1,3 +1,3 @@',
          sectionHeading: '',
          oldStart: 1,
          newStart: 1,
          lines: [
            { type: 'del', oldNumber: 1, newNumber: null, content: '# Pricing (legacy)' },
            { type: 'add', oldNumber: null, newNumber: 1, content: '# Pricing' },
            { type: 'context', oldNumber: 2, newNumber: 2, content: '' },
            { type: 'context', oldNumber: 3, newNumber: 3, content: 'How prices are computed.' },
          ],
        },
      ],
    },
    {
      id: 'd4',
      oldPath: 'assets/logo.png',
      newPath: 'assets/logo.png',
      status: 'modified',
      isBinary: true,
      language: null,
      additions: 0,
      deletions: 0,
      hunks: [],
    },
  ],
};
