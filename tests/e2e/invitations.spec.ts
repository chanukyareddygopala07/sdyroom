import { expect, test, type Page } from "@playwright/test";
import { psql } from "../integration/helpers/admin";
import {
  createRoomViaUi,
  roomCard,
  searchRooms,
} from "./helpers/rooms";
import { signUpAndOnboard, type E2EUser } from "./helpers/users";

/** The helper always records one; the guard keeps TypeScript honest. */
function aliasOf(user: E2EUser): string {
  if (!user.alias) {
    throw new Error(`No alias recorded for ${user.email}`);
  }
  return user.alias;
}

/**
 * Addressed invitations (007) through the real UI: the owner invites by
 * alias, the invitee accepts from their inbox and lands in a workspace whose
 * roster lists both of them — while everyone else gets no link, no
 * discovery row, and the same 404 as a missing room. Rejected, revoked,
 * expired and full-room outcomes are covered here too; the state machine
 * itself is integration-tested against the handlers.
 */

function invitePanel(page: Page, roomId: string) {
  return page.getByRole("region", { name: "Invite a student" }).filter({
    has: page.locator(`#invite-alias-${roomId}`),
  });
}

function rosterSection(page: Page) {
  return page.getByRole("region", { name: "Members" });
}

async function sendInvitation(page: Page, roomId: string, alias: string) {
  const panel = invitePanel(page, roomId);
  await expect(panel.getByRole("heading", { name: "Invite a student" })).toBeVisible();
  await panel.locator(`#invite-alias-${roomId}`).fill(alias);
  await panel.getByRole("button", { name: "Send invitation" }).click();
  await expect(panel.getByText(`Invitation sent to ${alias}.`)).toBeVisible();
}

test("invitation lifecycle: owner invites, invitee accepts, roster shows both", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const inviteeContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const invitee = await inviteeContext.newPage();

  try {
    const ownerUser = await signUpAndOnboard(owner, "inv-owner");
    const inviteeUser = await signUpAndOnboard(invitee, "inv-guest");

    const room = await createRoomViaUi(owner, {
      label: "invite",
      capacity: 3,
      visibility: "private",
    });

    // The workspace offers both controls to the owner of a private room.
    await expect(rosterSection(owner)).toBeVisible();
    await expect(rosterSection(owner).getByText(aliasOf(ownerUser))).toBeVisible();

    // Before accepting: the room is still unlisted and closed to the guest.
    await expect(invitee.getByRole("link", { name: "Invitations" })).toBeVisible();
    await searchRooms(invitee, room.name);
    await expect(roomCard(invitee, room.name)).toHaveCount(0);
    await invitee.goto(`/rooms/${room.id}`);
    await expect(
      invitee.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();

    // The invite itself: alias in, success + a pending row out.
    await sendInvitation(owner, room.id, aliasOf(inviteeUser));
    await expect(
      invitePanel(owner, room.id).getByText(aliasOf(inviteeUser), {
        exact: true,
      }),
    ).toBeVisible();

    // The invitee's inbox carries it, addressed by the owner's alias.
    await invitee.getByRole("link", { name: "Invitations" }).click();
    await invitee.waitForURL(/\/invitations$/);
    const card = invitee
      .getByRole("listitem")
      .filter({ hasText: room.name });
    await expect(card).toBeVisible();
    await expect(card.getByText(`From ${aliasOf(ownerUser)}`)).toBeVisible();

    // Accepting grants the seat and lands them in the workspace.
    await card.getByRole("button", { name: `Accept invitation to ${room.name}` }).click();
    await invitee.waitForURL(new RegExp(`/rooms/${room.id}$`));
    await expect(
      invitee.getByRole("heading", { level: 1, name: room.name }),
    ).toBeVisible();

    // Both members, by alias, in both viewers' rosters — and the presence
    // channel the chat already runs annotates the owner for the guest.
    await expect(rosterSection(invitee).getByText(aliasOf(ownerUser))).toBeVisible();
    await expect(rosterSection(invitee).getByText(aliasOf(inviteeUser))).toBeVisible();
    await expect(
      rosterSection(invitee).getByText("2", { exact: true }),
    ).toBeVisible();
    const ownerRow = rosterSection(invitee)
      .getByRole("listitem")
      .filter({ hasText: aliasOf(ownerUser) });
    await expect(ownerRow.getByText("Here")).toBeVisible();

    // The roster and the pending list are server-rendered: the accept
    // happened after the owner's page was painted, so one refresh is how
    // the owner's own page learns about both.
    await owner.reload();
    await expect(rosterSection(owner).getByText(aliasOf(inviteeUser))).toBeVisible();
    await expect(
      invitePanel(owner, room.id).getByText("No pending invitations."),
    ).toBeVisible();
  } finally {
    await ownerContext.close();
    await inviteeContext.close();
  }
});

test("a third student gets nothing: no inbox row, no discovery, no URL", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const outsiderContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const outsider = await outsiderContext.newPage();

  try {
    await signUpAndOnboard(owner, "inv2-owner");
    await signUpAndOnboard(outsider, "inv2-outsider");

    const room = await createRoomViaUi(owner, {
      label: "unlisted",
      capacity: 3,
      visibility: "private",
    });

    // The outsider's inbox is empty: no row about this room, ever.
    await outsider.getByRole("link", { name: "Invitations" }).click();
    await outsider.waitForURL(/\/invitations$/);
    await expect(
      outsider.getByText(
        "No invitations yet — when a room owner invites you by alias, it appears here.",
      ),
    ).toBeVisible();

    // Unlisted in discovery, and the URL 404s like a missing room.
    await searchRooms(outsider, room.name);
    await expect(roomCard(outsider, room.name)).toHaveCount(0);
    await outsider.goto(`/rooms/${room.id}`);
    await expect(
      outsider.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
  } finally {
    await ownerContext.close();
    await outsiderContext.close();
  }
});

test("rejected, revoked and expired invitations never seat anyone", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const rejectedContext = await browser.newContext();
  const revokedContext = await browser.newContext();
  const expiredContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const rejectedStudent = await rejectedContext.newPage();
  const revokedStudent = await revokedContext.newPage();
  const expiredStudent = await expiredContext.newPage();

  try {
    await signUpAndOnboard(owner, "inv3-owner");
    const rejectedUser = await signUpAndOnboard(rejectedStudent, "inv3-rejected");
    const revokedUser = await signUpAndOnboard(revokedStudent, "inv3-revoked");
    const expiredUser = await signUpAndOnboard(expiredStudent, "inv3-expired");

    const room = await createRoomViaUi(owner, {
      label: "tidy",
      capacity: 4,
      visibility: "private",
    });

    // The owner invites all three students, then revokes the second.
    await sendInvitation(owner, room.id, aliasOf(rejectedUser));
    await sendInvitation(owner, room.id, aliasOf(revokedUser));
    await sendInvitation(owner, room.id, aliasOf(expiredUser));
    const revokedRow = invitePanel(owner, room.id)
      .getByRole("listitem")
      .filter({ hasText: aliasOf(revokedUser) });
    await revokedRow
      .getByRole("button", { name: `Revoke invitation for ${aliasOf(revokedUser)}` })
      .click();
    await expect(
      invitePanel(owner, room.id)
        .getByRole("listitem")
        .filter({ hasText: aliasOf(revokedUser) }),
    ).toHaveCount(0);

    // The third invitation is aged past its deadline by the database itself
    // — expiry is read-time, so backdating the row is the deadline.
    const invitationId = psql(
      `select id from public.room_invitations ` +
        `where room_id = '${room.id}' and invitee_alias = '${aliasOf(expiredUser)}';`,
    ).trim();
    psql(
      `update public.room_invitations ` +
        `set created_at = now() - interval '2 days', ` +
        `expires_at = now() - interval '1 hour' where id = '${invitationId}';`,
    );

    // Rejected: declined from the inbox, the row becomes history, and the
    // workspace still refuses them.
    await rejectedStudent.getByRole("link", { name: "Invitations" }).click();
    await rejectedStudent.waitForURL(/\/invitations$/);
    const rejectedCard = rejectedStudent
      .getByRole("listitem")
      .filter({ hasText: room.name });
    await rejectedCard
      .getByRole("button", { name: `Reject invitation to ${room.name}` })
      .click();
    await expect(
      rejectedCard.getByText("Rejected", { exact: true }),
    ).toBeVisible();
    await rejectedStudent.goto(`/rooms/${room.id}`);
    await expect(
      rejectedStudent.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();

    // Revoked: visible to its invitee as revoked, with no action left.
    await revokedStudent.getByRole("link", { name: "Invitations" }).click();
    await revokedStudent.waitForURL(/\/invitations$/);
    const revokedCard = revokedStudent
      .getByRole("listitem")
      .filter({ hasText: room.name });
    await expect(revokedCard.getByText("Revoked", { exact: true })).toBeVisible();
    await expect(revokedCard.getByRole("button", { name: "Accept" })).toHaveCount(0);
    await revokedStudent.goto(`/rooms/${room.id}`);
    await expect(
      revokedStudent.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();

    // Expired: reported as expired rather than pending, with no action.
    await expiredStudent.getByRole("link", { name: "Invitations" }).click();
    await expiredStudent.waitForURL(/\/invitations$/);
    const expiredCard = expiredStudent
      .getByRole("listitem")
      .filter({ hasText: room.name });
    await expect(expiredCard.getByText("Expired", { exact: true })).toBeVisible();
    await expect(expiredCard.getByRole("button", { name: "Accept" })).toHaveCount(0);
    await expiredStudent.goto(`/rooms/${room.id}`);
    await expect(
      expiredStudent.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();

    // Nobody ever held a seat but the owner.
    expect(
      Number(
        psql(
          `select count(*) from public.room_members where room_id = '${room.id}';`,
        ),
      ),
    ).toBe(1);
  } finally {
    await ownerContext.close();
    await rejectedContext.close();
    await revokedContext.close();
    await expiredContext.close();
  }
});

test("a full room: the second invitation loses the last seat with an explanation", async ({
  browser,
}) => {
  const ownerContext = await browser.newContext();
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const firstStudent = await firstContext.newPage();
  const secondStudent = await secondContext.newPage();

  try {
    await signUpAndOnboard(owner, "inv4-owner");
    const firstUser = await signUpAndOnboard(firstStudent, "inv4-first");
    const secondUser = await signUpAndOnboard(secondStudent, "inv4-second");

    const room = await createRoomViaUi(owner, {
      label: "lastseat",
      capacity: 2,
      visibility: "private",
    });
    await sendInvitation(owner, room.id, aliasOf(firstUser));
    await sendInvitation(owner, room.id, aliasOf(secondUser));

    // First accept takes the owner's one free seat.
    await firstStudent.getByRole("link", { name: "Invitations" }).click();
    await firstStudent.waitForURL(/\/invitations$/);
    const firstCard = firstStudent
      .getByRole("listitem")
      .filter({ hasText: room.name });
    await firstCard
      .getByRole("button", { name: `Accept invitation to ${room.name}` })
      .click();
    await firstStudent.waitForURL(new RegExp(`/rooms/${room.id}$`));
    await expect(
      firstStudent.getByRole("heading", { level: 1, name: room.name }),
    ).toBeVisible();

    // The second accept is refused from the database's own seat check, and
    // the row says so without pretending anything else went wrong.
    await secondStudent.getByRole("link", { name: "Invitations" }).click();
    await secondStudent.waitForURL(/\/invitations$/);
    const secondCard = secondStudent
      .getByRole("listitem")
      .filter({ hasText: room.name });
    await secondCard
      .getByRole("button", { name: `Accept invitation to ${room.name}` })
      .click();
    await expect(secondCard.getByText("This room is full.")).toBeVisible();

    // Still outside: no seat, no workspace.
    await secondStudent.goto(`/rooms/${room.id}`);
    await expect(
      secondStudent.getByRole("heading", { name: "Page not found" }),
    ).toBeVisible();
    expect(
      Number(
        psql(
          `select count(*) from public.room_members where room_id = '${room.id}';`,
        ),
      ),
    ).toBe(2);
  } finally {
    await ownerContext.close();
    await firstContext.close();
    await secondContext.close();
  }
});
