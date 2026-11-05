import {expect,it} from 'vitest';
import {web} from '../src/index';
it('is independent',()=>{expect(web()).toBe('independent');});
