import { z } from "zod";
import {
  afsAnnotationSchema, captureSchema, guestReviewSchema, pinpointContextSchema,
  threadMessageSchema, workflowStateSchema,
} from "./afs";
import { GUEST_PREVIEW_ISOLATION_VERSION } from "./protocol";

export interface GuestPermissions {
  capture: boolean;
  reply: boolean;
  delete: boolean;
}

export const guestActorSchema = guestReviewSchema.omit({ pendingOwnerDispatch: true });
export type GuestActor = z.infer<typeof guestActorSchema>;
export const guestReviewScopeSchema = guestActorSchema.extend({
  isolationVersion: z.literal(GUEST_PREVIEW_ISOLATION_VERSION),
  threadId: z.string().min(1), url: z.string().url(),
}).strict();
export type GuestReviewScope = z.infer<typeof guestReviewScopeSchema>;
export const guestRowInputSchema = guestReviewScopeSchema.extend({ id: z.string().min(1) }).strict();
export const guestCaptureInputSchema = captureSchema.omit({ sourceFile: true }).extend({
  ...guestActorSchema.shape,
  isolationVersion: z.literal(GUEST_PREVIEW_ISOLATION_VERSION),
  threadId: z.string().min(1), url: z.string().url(), comment: z.string().max(4_000),
}).strict().refine((input) => input.kind === "text-edit" || input.comment.trim().length > 0);
export const guestCaptureReceiptSchema = z.object({
  captureId: z.string(),
  screenshotUpload: z.object({ token: z.string(), expiresAt: z.number() }).nullable(),
}).strict();

export const guestFeedbackSchema = z.object({
  revision: z.string(),
  capture: z.object({ comment: z.string().max(4_000), textNew: z.string().max(500).nullable() }).strict().nullable(),
  messages: z.array(z.object({ id: z.string(), content: z.string().trim().min(1).max(4_000) }).strict()),
}).strict();
export type GuestFeedback = z.infer<typeof guestFeedbackSchema>;

// A whitelist, not a redacted owner-row copy. Nested private extensions are stripped.
export const publicGuestAnnotationSchema = afsAnnotationSchema.pick({
  id: true, comment: true, elementPath: true, timestamp: true,
  x: true, y: true, element: true, url: true, selectedText: true,
  kind: true, textOld: true, textNew: true,
}).extend({
  pinpoint: pinpointContextSchema.pick({
    selector: true, pathname: true, title: true, authorRole: true,
    anchorOffset: true, xIsPercentage: true,
  }).strip().extend({ ownerEdited: z.boolean().optional() }),
  thread: z.array(threadMessageSchema.pick({ role: true, content: true, guest: true }).strip().extend({
    ownerEdited: z.boolean().optional(),
  })),
}).strip();
export const guestRowSchema = z.object({
  annotation: publicGuestAnnotationSchema,
  workflowState: workflowStateSchema,
  summary: z.string().nullable(), screenshots: z.array(z.enum(["element", "viewport"])),
  createdAt: z.number(), guestPending: z.boolean(), guestCanDelete: z.boolean(),
  authoredByGuest: z.boolean(),
}).strict();
export type GuestRow = z.infer<typeof guestRowSchema>;

export const preparedGuestResourceSchema = z.object({
  isolationVersion: z.literal(GUEST_PREVIEW_ISOLATION_VERSION),
  headers: z.record(z.string(), z.string()),
  contentType: z.string(), bodyBase64: z.string(),
}).strict();
