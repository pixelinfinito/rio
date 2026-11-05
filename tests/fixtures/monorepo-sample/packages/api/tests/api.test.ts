import {expect,it} from 'vitest';
import {api} from '../src/index';
it('covers the shared package through the consumer',()=>{expect(api(4)).toBe(8);});
