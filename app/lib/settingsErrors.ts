/** Lỗi server bắt đầu bằng tên trường (có thể kèm tiền tố `settings.`, chỉ số `[n]` hoặc `.<model>`). */
export function errorsFor(errors: string[], key: string): string[] {
  const re = new RegExp('^(settings\\.)?' + key.replace(/\./g, '\\.') + '(?!\\w)');
  return errors.filter((e) => re.test(e));
}
