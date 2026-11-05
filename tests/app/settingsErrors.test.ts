import { expect, test } from 'vitest';
import { errorsFor } from '../../app/lib/settingsErrors';

test('errorsFor khớp tiền tố settings., chỉ số và prices.<model>', () => {
  const errs = ['settings.maxParallel phải ≥ 1', 'denyBash[2] không hợp lệ', 'settings.denyBash[0] sai', 'prices.claude-x.in âm', 'thresholds.stuckMs phải > 0', 'roleDefaults.dev.model "x" không nằm trong allowedModels.claude'];
  expect(errorsFor(errs, 'maxParallel')).toEqual([errs[0]]);
  expect(errorsFor(errs, 'denyBash')).toEqual([errs[1], errs[2]]);
  expect(errorsFor(errs, 'prices')).toEqual([errs[3]]);
  expect(errorsFor(errs, 'thresholds.stuckMs')).toEqual([errs[4]]);
  expect(errorsFor(errs, 'roleDefaults.dev.model')).toEqual([errs[5]]);
  expect(errorsFor(errs, 'allowedModels.claude')).toEqual([]);
  expect(errorsFor(errs, 'maxRounds')).toEqual([]);
});

test('errorsFor: dấu chấm trong khoá không là ký tự đại diện', () => {
  expect(errorsFor(['thresholdsXstuckMs sai'], 'thresholds.stuckMs')).toEqual([]);
});
