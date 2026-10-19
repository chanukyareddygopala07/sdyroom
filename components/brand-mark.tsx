import logo from "@/public/images/sdyroom-logo-256.png";
import { cn } from "@/lib/utils";
import Image from "next/image";

/**
 * The official SdyRoom mark, served from `public/images` (copied from
 * `docs/images/sdyroom-logo.png`, downscaled only — never redrawn). When it
 * sits beside the visible wordmark it is decorative (`alt=""`); the hero on
 * the landing page passes a real `alt` because it is the only logo there.
 */
export function BrandMark({
  size = 28,
  alt = "",
  className,
}: {
  size?: number;
  alt?: string;
  className?: string;
}) {
  return (
    <Image
      src={logo}
      alt={alt}
      width={size}
      height={size}
      className={cn("shrink-0 select-none", className)}
      draggable={false}
      priority={size >= 44}
    />
  );
}
