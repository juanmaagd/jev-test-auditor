import { describe, expect, it } from 'vitest';
import { EventBus } from './emitter.js';

describe('bus', () => {
  it('checks listener count', () => {
    const bus = new EventBus();
    bus.subscribe(() => {});
    expect(bus.listenerCount).toBe(1);
  });
});
