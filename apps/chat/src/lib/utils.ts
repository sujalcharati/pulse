import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn convention: cn() merges Tailwind classes intelligently so
 *  variant overrides actually win (e.g. cn("p-2", "p-4") → "p-4"). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
