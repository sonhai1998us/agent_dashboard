import { describe, expect, it } from 'vitest';
import { OVERFLOW_SCRIPT } from '@/src/preview/browser';

// Dashboard chạy bằng tsx: esbuild chèn __name(...) vào hàm được đặt tên, nên code chạy trong trang phải là chuỗi JS thuần.
describe('script chạy trong trang', () => {
  it('OVERFLOW_SCRIPT là chuỗi JS tự chứa, không phụ thuộc helper của trình biên dịch', () => {
    expect(typeof OVERFLOW_SCRIPT).toBe('string');
    expect(OVERFLOW_SCRIPT).not.toMatch(/__name|__defProp|_ts|require\(/);
    const el = (tag: string, id: string, cls: string, right: number, width: number) => ({
      tagName: tag.toUpperCase(), id, className: cls, getBoundingClientRect: () => ({ right, width }),
    });
    const document = {
      documentElement: { clientWidth: 375, scrollWidth: 900 },
      body: { querySelectorAll: () => [el('div', 'wide', 'a b c', 900, 900), el('p', '', '', 100, 50)] },
    };
    const run = new Function('document', `return (${OVERFLOW_SCRIPT})(10);`);
    expect(run(document)).toEqual({ scrollWidth: 900, clientWidth: 375, items: [{ selector: 'div#wide.a.b', width: 900, right: 900 }] });
  });
});
