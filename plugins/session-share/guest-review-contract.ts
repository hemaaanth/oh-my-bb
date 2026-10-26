import { z } from "zod";

// Contract 1 is decoded locally. No owner rows or nested private extensions cross the guest boundary.
export const guestRowSchema = z.object({
  annotation: z.object({
    id: z.string().min(1), comment: z.string(), elementPath: z.string(), timestamp: z.number(),
    x: z.number(), y: z.number(), element: z.string(),
    kind: z.enum(["feedback", "placement", "rearrange", "text-edit"]),
    url: z.string().optional(), selectedText: z.string().optional(),
    textOld: z.string().optional(), textNew: z.string().optional(),
    pinpoint: z.object({
      selector: z.string().nullable(), pathname: z.string().nullable(), title: z.string().nullable(),
      xIsPercentage: z.boolean(), authorRole: z.enum(["human", "agent"]).optional(),
      ownerEdited: z.boolean().optional(),
      anchorOffset: z.object({ x: z.number(), y: z.number() }).strip().optional(),
    }).strip(),
    thread: z.array(z.object({
      role: z.enum(["human", "agent"]), content: z.string(), guest: z.boolean().optional(),
      ownerEdited: z.boolean().optional(),
    }).strip()),
  }).strip(),
  workflowState: z.enum(["open", "dispatched", "waiting-input", "ready", "approved", "dismissed"]),
  summary: z.string().nullable(), screenshots: z.array(z.enum(["element", "viewport"])),
  createdAt: z.number(), guestPending: z.boolean(), guestCanDelete: z.boolean(), authoredByGuest: z.boolean(),
}).strip();
export const guestListOutputSchema = z.object({ rows: z.array(guestRowSchema) }).strip();
export const guestCaptureOutputSchema = z.object({
  captureId: z.string().min(1),
  screenshotUpload: z.object({ token: z.string().min(1), expiresAt: z.number() }).strict().nullable(),
}).strict();
export type GuestRow = z.infer<typeof guestRowSchema>;
