import type { ComponentProps } from "react";
import { Renderer } from "@openuidev/react-lang";
import type { Tools } from "./kit.js";

type Props = Omit<ComponentProps<typeof Renderer>, "toolProvider" | "children"> & { toolProvider?: Tools };

export function SpecRenderer(props: Props) {
  return <Renderer {...props}>
    <Renderer.Content />
    <Renderer.QueryLoading />
    <Renderer.QueryError><Renderer.Retry /></Renderer.QueryError>
  </Renderer>;
}
