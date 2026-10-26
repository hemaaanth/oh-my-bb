export function ErrorLine({ message }: { message: string }) {
  return <p role="alert" className="m-0 break-words text-xs text-destructive">{message}</p>;
}
