import { z } from "zod";

export const ALIAS_MIN_LENGTH = 1;
export const ALIAS_MAX_LENGTH = 32;

const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]*$/;

/**
 * Study alias shown in the app. Mirrors `profiles.alias` in 0001_init.sql
 * (trimmed, 1-32 characters) and adds a friendlier character set so aliases
 * stay readable in room listings. Uniqueness is case-insensitive in the
 * database via a unique index on `lower(alias)`; conflicts surface as 23505.
 */
export const aliasSchema = z
  .string()
  .trim()
  .min(ALIAS_MIN_LENGTH, "Study alias is required")
  .max(
    ALIAS_MAX_LENGTH,
    `Study alias must be ${ALIAS_MAX_LENGTH} characters or fewer`,
  )
  .regex(
    ALIAS_PATTERN,
    "Study alias must start with a letter or number and use only letters, numbers, spaces, hyphens or underscores",
  );

export const onboardingSchema = z.object({
  alias: aliasSchema,
});

export type OnboardingInput = z.infer<typeof onboardingSchema>;
