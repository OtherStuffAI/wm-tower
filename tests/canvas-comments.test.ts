import { expect, test } from 'bun:test';
import { assertCanvasCommentDeletion, canvasCommentPermissions, CanvasCommentPermissionError, FlightDeckPgCanvasConflictError } from '../src/services/flightdeck-pg-canvases';
import { canvasSpatialContext } from '../src/services/canvas-spatial-context';

const root = { id: 'root', parent_comment_id: null, created_by_actor_id: 'alice', row_version: 1 } as any;
const reply = { id: 'reply', parent_comment_id: 'root', created_by_actor_id: 'bob', row_version: 2 } as any;

test('authors control their own replies, foreign replies protect roots, managers may delete with exact confirmation', () => {
  expect(canvasCommentPermissions(root, [root], 'alice', false)).toEqual({ can_delete: true, can_resolve: true, can_retarget: true, retarget_preserves_position: true });
  expect(canvasCommentPermissions(root, [root, reply], 'alice', false).can_delete).toBe(false);
  expect(canvasCommentPermissions(reply, [root, reply], 'bob', false)).toEqual({ can_delete: true, can_resolve: false, can_retarget: false, retarget_preserves_position: true });
  expect(canvasCommentPermissions(root, [root], 'bob', false).can_retarget).toBe(false);
  expect(() => assertCanvasCommentDeletion(root, [root, reply], 'alice', false, { reply: 2 })).toThrow(CanvasCommentPermissionError);
  expect(() => assertCanvasCommentDeletion(root, [root, reply], 'manager', true, { reply: 2 })).not.toThrow();
  expect(() => assertCanvasCommentDeletion(reply, [root, reply], 'bob', false)).not.toThrow();
  expect(() => assertCanvasCommentDeletion(root, [root], 'alice', false, {})).not.toThrow();
  for (const confirmation of [undefined, {}, { reply: 1 }, { reply: 2, new: 1 }]) expect(() => assertCanvasCommentDeletion(root, [root, reply], 'manager', true, confirmation)).toThrow(FlightDeckPgCanvasConflictError);
});

test('spatial context contains bounds, excludes restricted identities, distinguishes explicit intent from nearest inference', () => {
  const bounds = { x: 100, y: 50, width: 200, height: 100, z: 2 };
  const naplets = [{ id: 'subject', access: 'ready', layout: bounds }, { id: 'secret', access: 'denied', layout: bounds }];
  const comments = [
    { id: 'a', parent_comment_id: null, anchor: { type: 'naplet', naplet_id: 'subject' } },
    { id: 'b', parent_comment_id: 'a', anchor: { type: 'canvas', x: 999, y: 999 } },
    { id: 'c', parent_comment_id: null, anchor: { type: 'canvas', x: 90, y: 50 } },
  ];
  const context = canvasSpatialContext(naplets, [{ id: 'shape', kind: 'rectangle', layout: bounds }], comments);
  expect(context.items).toHaveLength(2);
  expect(JSON.stringify(context)).not.toContain('secret');
  expect(context.comments[0].explicit_target).toEqual({ type: 'naplet', id: 'subject', authority: 'explicit' });
  expect(context.comments[0].proximity_candidates).toEqual([]);
  expect(context.comments[1].position).toEqual({ x: 300, y: 50 });
  expect(context.comments[2].explicit_target).toBeNull();
  expect(context.comments[2].proximity_candidates[0]).toMatchObject({ distance_to_bounds: 10, basis: 'geometric_inference' });
  const moved = canvasSpatialContext([{ ...naplets[0], layout: { ...bounds, x: 500 } }], [], comments);
  expect(moved.comments[0].position.x).toBe(700);
  expect(moved.comments[0].explicit_target?.id).toBe('subject');
});
