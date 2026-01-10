# Mitsubishi Lancer Evolution X 2008 Service Manual

Fully featured, web-safe edition of the entire manual. Made here, for your viewing pleasure. No downloads, no broken links.

## [View the manual here](https://colecrouter.github.io/evo-manual-fix/)

## [Offline download](https://github.com/colecrouter/evo-manual-fix/releases/download/offline/PDFs.zip)

I got tired of downloading all 61 PDFs on every single device I own, so I wrote a script to fix the links in `INDEX.pdf`, and wrote an action to upload the files to GitHub Pages.

## Link base URL

The build script can generate absolute links (better mobile compatibility) by setting `EVO_MANUAL_BASE_URL`.

- Example: `EVO_MANUAL_BASE_URL=https://colecrouter.github.io/evo-manual-fix/`
- If not set, the script will infer a GitHub Pages URL when running in GitHub Actions, otherwise it falls back to relative `./` links.

## Credits

Manual taken from here: <http://norcalmotorsports.org/users/bryan/mods/EVO/tech/ServiceManuals/Evo_X_Service_Manual.zip>
