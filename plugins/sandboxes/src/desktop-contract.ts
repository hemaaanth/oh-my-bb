import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
const processOwner=z.object({pid:z.number().int().min(2),start:z.string().regex(/^\d+$/)}).strict();
export const desktopTarget=z.object({display:z.string().regex(/^:\d+$/),authority:z.string().min(1).max(4096),vncSocket:z.string().regex(/^\/tmp\/bb-vnc-[a-f0-9]{32}\.sock$/).optional(),owner:processOwner,displayOwner:processOwner}).strict();
export type DesktopTarget=z.infer<typeof desktopTarget>;
export const desktopHostContract=defineRpcContract({
 openDesktop:{input:z.object({id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),target:desktopTarget,appOrigin:z.string().max(512).refine(value=>{try{const url=new URL(value);return ['http:','https:'].includes(url.protocol)&&url.origin===value;}catch{return false;}}).optional(),viewOnly:z.boolean().default(false),threadTitle:z.string().min(1).max(240),token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),clientScript:z.string().max(600000),notices:z.string().max(60000),tunnel:z.object({label:z.string().regex(/^[a-z0-9-]+$/),baseDomain:z.string().regex(/^[a-z0-9.-]+$/)})}).strict(),output:z.object({port:z.number().int().min(1024).max(65535),expires:z.number()})},
 closeDesktop:{input:z.object({id:z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)}).strict(),output:z.null()},
});
export const desktopRpcContract=defineRpcContract({
 desktopOpenV1:{input:z.object({threadId:z.string(),target:desktopTarget,viewOnly:z.boolean().default(false)}).strict(),output:z.object({url:z.string(),expires:z.number()})},
 desktopCloseV1:{input:z.object({threadId:z.string()}).strict(),output:z.null()},
});
