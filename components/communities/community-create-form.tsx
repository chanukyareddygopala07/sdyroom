"use client";

import {
  COMMUNITY_CATEGORIES,
  CATEGORY_LABELS,
  communityApiErrorMessage,
  suggestSlug,
} from "@/components/communities/_shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  CommunityApiError,
  createCommunityClient,
} from "@/lib/communities/api";
import { useRouter } from "next/navigation";
import { useState } from "react";

const NAME_MAX = 60;
const DESCRIPTION_MAX = 1000;
const RULES_MAX = 2000;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{2,38}[a-z0-9]$/;

/**
 * The create-community dialog. The slug is suggested from the name until
 * the student edits it, a private community is pinned to request-based
 * joining, and the server's `slug_taken` lands on the slug field instead of
 * a generic banner — the one error a student can actually fix here.
 */
export function CommunityCreateForm({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<string>("study");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [joinPolicy, setJoinPolicy] = useState<"open" | "request">("open");
  const [rules, setRules] = useState("");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [slugError, setSlugError] = useState<string | null>(null);

  const reset = () => {
    setName("");
    setSlug("");
    setSlugTouched(false);
    setDescription("");
    setCategory("study");
    setVisibility("public");
    setJoinPolicy("open");
    setRules("");
    setFormError(null);
    setSlugError(null);
    setSaving(false);
  };

  const handleChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;

    const trimmedSlug = slug.trim();
    if (!SLUG_PATTERN.test(trimmedSlug)) {
      setSlugError(
        "Use 4–40 lowercase letters, numbers and hyphens (no leading or trailing hyphen).",
      );
      return;
    }

    setSaving(true);
    setFormError(null);
    setSlugError(null);

    try {
      const { community } = await createCommunityClient({
        slug: trimmedSlug,
        name: name.trim(),
        description: description.trim(),
        category,
        visibility,
        joinPolicy: visibility === "private" ? "request" : joinPolicy,
        rules: rules.trim(),
      });
      router.push(`/communities/${community.id}`);
      router.refresh();
    } catch (caught) {
      setSaving(false);
      if (caught instanceof CommunityApiError && caught.code === "slug_taken") {
        setSlugError("That slug is already taken. Try another.");
        return;
      }
      setFormError(
        communityApiErrorMessage(
          caught,
          "The community could not be created.",
        ),
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New community</DialogTitle>
          <DialogDescription>
            A community is a durable, end-to-end encrypted space with its own
            channels. You become the owner.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <div className="grid gap-2">
            <Label htmlFor="community-create-name">Name</Label>
            <Input
              id="community-create-name"
              value={name}
              required
              maxLength={NAME_MAX}
              placeholder="Calculus Study Group"
              onChange={(event) => {
                const next = event.target.value;
                setName(next);
                if (!slugTouched) setSlug(suggestSlug(next));
              }}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="community-create-slug">Slug</Label>
            <Input
              id="community-create-slug"
              value={slug}
              required
              maxLength={40}
              placeholder="calculus-study-group"
              onChange={(event) => {
                setSlugTouched(true);
                setSlug(event.target.value);
                setSlugError(null);
              }}
              aria-invalid={slugError ? true : undefined}
              aria-describedby={
                slugError ? "community-create-slug-error" : undefined
              }
            />
            {slugError ? (
              <p
                id="community-create-slug-error"
                role="alert"
                className="text-sm text-error"
              >
                {slugError}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                The address of your community: lowercase letters, numbers and
                hyphens.
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="community-create-description">
              Description (optional)
            </Label>
            <Textarea
              id="community-create-description"
              value={description}
              maxLength={DESCRIPTION_MAX}
              className="min-h-20"
              placeholder="Who is this community for, and what do you study together?"
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="community-create-category">Category</Label>
            <Select
              id="community-create-category"
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              {COMMUNITY_CATEGORIES.map((value) => (
                <option key={value} value={value}>
                  {CATEGORY_LABELS[value]}
                </option>
              ))}
            </Select>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-medium">Visibility</legend>
            <RadioGroup
              value={visibility}
              onValueChange={(value) =>
                setVisibility(value as "public" | "private")
              }
              name="community-create-visibility"
              aria-label="Visibility"
            >
              <Label
                htmlFor="community-create-visibility-public"
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-normal"
              >
                <RadioGroupItem
                  id="community-create-visibility-public"
                  value="public"
                />
                Public — listed in discovery
              </Label>
              <Label
                htmlFor="community-create-visibility-private"
                className="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-normal"
              >
                <RadioGroupItem
                  id="community-create-visibility-private"
                  value="private"
                />
                Private — unlisted, join by request
              </Label>
            </RadioGroup>
          </fieldset>

          <div className="grid gap-2">
            <Label htmlFor="community-create-join-policy">Join policy</Label>
            <Select
              id="community-create-join-policy"
              value={visibility === "private" ? "request" : joinPolicy}
              disabled={visibility === "private"}
              onChange={(event) =>
                setJoinPolicy(event.target.value as "open" | "request")
              }
            >
              <option value="open">Open — anyone can join</option>
              <option value="request">Request — staff approve</option>
            </Select>
            {visibility === "private" && (
              <p className="text-xs text-muted-foreground">
                Private communities only accept request-based joining.
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="community-create-rules">
              Rules (optional)
            </Label>
            <Textarea
              id="community-create-rules"
              value={rules}
              maxLength={RULES_MAX}
              className="min-h-24"
              placeholder="Be kind. Study hard. No spoilers."
              onChange={(event) => setRules(event.target.value)}
            />
          </div>

          {formError && (
            <p role="alert" className="text-sm text-error">
              {formError}
            </p>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => handleChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={saving || name.trim() === ""}
              aria-busy={saving}
            >
              {saving ? "Creating…" : "Create community"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
