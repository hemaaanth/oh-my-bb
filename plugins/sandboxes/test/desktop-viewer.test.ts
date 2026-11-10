import {afterEach,expect,it,vi} from 'vitest';
import {ViewerLease} from '../src/desktop-viewer.js';
afterEach(()=>vi.useRealTimers());
it('rejects automatic contenders and duplicate sockets, then permits a reconnect after pair cleanup',()=>{
 const viewer=new ViewerLease(),secret=viewer.acquire(),cancel=vi.fn();
 expect(viewer.acquire()).toBeNull();expect(viewer.owns(null)).toBe(false);
 const pair=viewer.reserve(secret,cancel)!;
 expect(viewer.reserve(secret,vi.fn())).toBeNull();expect(cancel).not.toHaveBeenCalled();
 pair.done();const next=viewer.reserve(secret,vi.fn())!;
 pair.done();expect(viewer.reserve(secret,vi.fn())).toBeNull();expect(next.current()).toBe(true);
});
it('consumes transfer tickets once, cancels pending upgrades and prevents late callbacks from clearing the new pair',()=>{
 const viewer=new ViewerLease(),first=viewer.acquire(),cancel=vi.fn(),pending=viewer.reserve(first,cancel)!;
 const ticket=viewer.transfer(first)!;expect(cancel).not.toHaveBeenCalled();
 const second=viewer.acquire(false,ticket)!;
 expect(cancel).toHaveBeenCalledOnce();expect(pending.current()).toBe(false);
 expect(viewer.acquire(false,ticket)).toBeNull();expect(viewer.reserve(first,vi.fn())).toBeNull();
 const current=viewer.reserve(second,vi.fn())!;pending.done();
 expect(current.current()).toBe(true);expect(viewer.reserve(second,vi.fn())).toBeNull();
 viewer.release(first);expect(current.current()).toBe(true);
 viewer.release(second);expect(current.current()).toBe(false);
});
it('binds tickets to generation and expiry, without revoking the owner when a popup is blocked or never navigates',()=>{
 vi.useFakeTimers();
 const viewer=new ViewerLease(),first=viewer.acquire(),ticket=viewer.transfer(first)!;
 vi.advanceTimersByTime(30000);expect(viewer.acquire(false,ticket)).toBeNull();expect(viewer.owns(first)).toBe(true);
 const stale=viewer.transfer(first)!;const second=viewer.acquire(true);
 expect(viewer.acquire(false,stale)).toBeNull();expect(viewer.owns(second)).toBe(true);
});
