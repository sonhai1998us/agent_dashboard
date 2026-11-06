import { expect, test } from 'vitest';
import { pathCrumbs, pickerStart } from '@/app/lib/dirs';

test('pathCrumbs: Windows', () => {
  expect(pathCrumbs('d:\\Work\\du-an\\')).toEqual([
    { label: 'D:\\', path: 'D:\\' },
    { label: 'Work', path: 'D:\\Work' },
    { label: 'du-an', path: 'D:\\Work\\du-an' },
  ]);
  expect(pathCrumbs('C:\\')).toEqual([{ label: 'C:\\', path: 'C:\\' }]);
  expect(pathCrumbs('C:/a/b')).toEqual([
    { label: 'C:\\', path: 'C:\\' }, { label: 'a', path: 'C:\\a' }, { label: 'b', path: 'C:\\a\\b' },
  ]);
});

test('pathCrumbs: POSIX và rỗng', () => {
  expect(pathCrumbs('/home/a')).toEqual([{ label: '/', path: '/' }, { label: 'home', path: '/home' }, { label: 'a', path: '/home/a' }]);
  expect(pathCrumbs('/')).toEqual([{ label: '/', path: '/' }]);
  expect(pathCrumbs(null)).toEqual([]);
});

test('pickerStart: ô nhập tuyệt đối → thư mục cha của dự án gần nhất → gốc', () => {
  expect(pickerStart(' D:\\Work\\x ', ['E:\\a\\b'])).toBe('D:\\Work\\x');
  expect(pickerStart('/srv/app', [])).toBe('/srv/app');
  expect(pickerStart('tương đối', ['D:\\Work\\du-an'])).toBe('D:\\Work');
  expect(pickerStart('', ['D:\\'])).toBe('D:\\');
  expect(pickerStart('', [])).toBeNull();
});
