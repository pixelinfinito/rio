import {expect,it} from 'vitest';
import {format} from '../src/math';
it('formats a number',()=>{expect(format(12)).toBe('12.00');});
