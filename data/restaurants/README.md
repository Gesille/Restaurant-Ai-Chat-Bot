# Restaurants (source of truth)

One JSON file per restaurant. **Every deploy syncs these files into the database**, so to add or change a
restaurant you edit a file and `git push`. Nothing to run by hand.

- Start from `example-full.json` (files whose name starts with `example` are ignored by the sync).
- `origins`: the restaurant website's exact address(es), e.g. `["https://bigbanana.com", "https://www.bigbanana.com"]`.
  The WordPress plugin finds its restaurant by these, so no key has to be pasted anywhere.
- `publish: true` makes FAQs and policies visible to the assistant (`false` keeps them as drafts).
- Prices are numbers (`18.5`), hours are `HH:MM` 24h; a day with `[]` is closed.
- Removing a menu item or FAQ from the file archives it (it is never deleted, re-adding restores it).
- Allergens are saved once, as **unverified**: the assistant never states unverified allergens and gives the
  phone number instead. A person verifies them through the API.
- CI checks every file (`tests/restaurant-sync.test.ts`): a typo fails the build instead of the deploy.
- A new restaurant's owner password is printed once and saved only on the server in `deploy/credentials.log`.
