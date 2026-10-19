# Image assets

Screenshots, demo recordings and other visual assets for the repository
presentation live in this directory. The project logo is checked in
(`sdyroom-logo.png`, referenced by the README hero); screenshots and demo
recordings are still pending — the README's Screenshots & Demo section carries a
commented placeholder until the first real screenshot lands.

## The logo

`sdyroom-logo.png` is the single source of truth for the brand mark. The
application never reads this file directly: `public/images/sdyroom-logo.png`
(full-size copy) and `public/images/sdyroom-logo-256.png` (header-sized
downscale) are produced from it, and `app/favicon.ico` / `app/icon.png` are
derived the same way. When the artwork changes, regenerate all four with
downscale-only resampling — never redraw, recolour or distort the mark.

## Checked in

| File | Shows |
| --- | --- |
| `sdyroom-logo.png` | The SdyRoom logo/mark (1254×1254 RGBA PNG, ~1.1 MB), shown at the top of `README.md` |

## How to add one

1. Capture the app from the local stack (`npx supabase start && npm run dev`).
   Sign in with a throwaway account and use realistic sample data — never real
   student details.
2. Save the file here (see naming below).
3. Reference it from `README.md`, ideally next to the existing placeholder
   comment:

   ```html
   <div align="center">
     <img src="docs/images/rooms.png" alt="SdyRoom room discovery" width="900" />
   </div>
   ```

## Naming and formats

| Name | Shows |
| --- | --- |
| `hero.png` | Wide hero / landing page shot for the README top |
| `rooms.png` | Room discovery with search |
| `workspace.png` | The study workspace: roster, focus timer, chat |
| `resources.png` | The personal resource library with the quota line |
| `sdyroom-demo.gif` | Short workflow recording (sign-up → join → study) |

Conventions:

- **Screenshots**: PNG, capped around 1 MB (e.g. `sips -Z 1600 <file>` to resize)
- **Demo GIF**: keep it under ~5 MB, under ~20 s, and silent (no fake data, no
  notifications, no browser tabs with personal content)
- Use light or dark theme consistently within a section
- Alt text must describe what the image shows
