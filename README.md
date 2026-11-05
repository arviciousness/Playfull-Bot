# Playfull bot

One Discord bot for the Playfull server. It replaces UnbelievaBoat (PlayBits, chat earnings, the ticket shop), Giveaway Boat (the weekly raffle), and StatBot (Gaming Hub voice time).

Members earn PlayBits, spend cash PlayBits on raffle tickets, and enter the weekly giveaway with a button. Entries are weighted by the tickets they hold. Moderators approve activity claims with buttons. After the draw, tickets and the four temporary activity roles expire. PlayBits balances are never wiped.

The rules that disagree with each other in the playbook are settings in `config/config.json`, not hard-coded. The defaults follow the UnbelievaBoat shop. See [Playbook contradictions](#playbook-contradictions).

## What you need to do

1. Create the Discord application and bot token (below).
2. Turn on the two privileged intents.
3. Invite the bot and create the roles.
4. Copy `config/config.example.json` to `config/config.json` and paste your server ID.
5. Copy `.env.example` to `.env` and paste the token and application ID.
6. Import existing PlayBits from a CSV before you turn off UnbelievaBoat.
7. Leave the bot running 24/7 on a small Linux server.

Do not put the bot token in `config.json`, in git, or in a Discord message. It belongs only in `.env`.

## 1. Create the Discord application

1. Open [https://discord.com/developers/applications](https://discord.com/developers/applications) and click **New Application**. Name it something members will recognize, such as `Playfull`.
2. Open **Bot** in the left sidebar and click **Reset Token**. Copy the token and store it somewhere private. This is the only time Discord shows it. That value is `DISCORD_TOKEN`.
3. On the same Bot page, turn **off** "Public Bot" if you do not want other people to invite it.
4. Open **Installation** (or the OAuth2 URL generator, either works) only after the intents below are on. You will invite it in step 3.
5. Open **General Information** and copy the **Application ID**. That value is `DISCORD_CLIENT_ID`.

### Privileged intents

Still on the **Bot** page, under **Privileged Gateway Intents**, turn these **on**:

- **Server Members Intent** — needed to read roles, assign roles, and remove weekly roles from everyone.
- **Message Content Intent** — needed so chat in general, spanish, japanese, filipino, and russian can earn PlayBits.

Save the page. If these are off, the bot will log in but it will not pay chat PlayBits and the weekly role cleanup will miss people.

Voice State is not a privileged intent. The bot still needs it, and the code requests it automatically.

## 2. Invite the bot

Replace `YOUR_APPLICATION_ID` and open this link while logged into Discord as someone who can manage the server:

```text
https://discord.com/api/oauth2/authorize?client_id=YOUR_APPLICATION_ID&permissions=361045773312&scope=bot%20applications.commands
```

That permission set lets the bot:

- view channels, send messages, send embeds, and read history
- manage roles (only the roles listed in the config, and only if the bot's own role is higher)
- create and manage private threads for the winner

After it joins, open **Server Settings → Roles** and drag the bot's role **above** every role it will assign: Trend Hunter, Game Creator, Party Legend, Playmaker, Playfull Patron, and the ticket-holder roles. If it sits below them, purchases and approvals will save the PlayBits but Discord will refuse the role.

## 3. Roles and channels

Create these roles if they do not already exist. Names must match `config.json`, or put the numeric role ID there instead (turn on Discord Developer Mode, right-click the role, Copy Role ID).

| Config key | Default name | Removed every week? |
| --- | --- | --- |
| `verified` | verified | No |
| `moderator` | Moderator | No. Can run mod commands. |
| `admin` | Discord Management | No. Can run management commands. The server owner and anyone with Administrator can too. |
| `serverBooster` | Server Booster | No. Discord's boost role also counts via the boost itself. |
| `trendHunter` | Trend Hunter | Yes |
| `gameCreator` | Game Creator | Yes |
| `partyLegend` | Party Legend | Yes |
| `playmaker` | Playmaker | Yes |
| `playfullPatron` | Playfull Patron | **Never** |
| `bronzeTicket` | Bronze Ticket Holder | Yes, with the tickets |
| `silverTicket` | Silver Ticket Holder | Yes |
| `goldTicket` | Gold Ticket Holder | Yes |
| `platinumTicket` | Platinum Ticket Holder | Yes |
| `diamondTicket` | Diamond Ticket Holder | Yes, if you later enable Diamond |
| `giveawayAlerts` | Giveaway Alerts | No. Optional ping when posting the guide. |

Channels the bot looks up by name (emoji and punctuation are ignored, so `🎁︱giveaways` matches `giveaways`):

| Purpose | Default name |
| --- | --- |
| Staff commands only | `admin-cmds` |
| Every PlayBits change | `PlayBits-vault` |
| Giveaway post | `giveaways` |
| Winner announcement | `events` |
| Ticket shop | `playbits-shop` |
| Chat earnings | `general`, `spanish`, `japanese`, `filipino`, `russian` |
| Voice time | a voice channel named `Gaming Hub` |

Prefer pasting channel IDs into the config if two channels could normalize to the same name.

## 4. Config file

On the machine that will run the bot:

```bash
cp config/config.example.json config/config.json
cp .env.example .env
```

Edit `.env`:

```text
DISCORD_TOKEN=the-token-from-the-bot-page
DISCORD_CLIENT_ID=the-application-id
```

Edit `config.json` and set `guildId` to the server ID (right-click the server icon → Copy Server ID). You can instead set `DISCORD_GUILD_ID` in `.env`.

Keys that start with `_` are notes. The bot ignores them.

Shop prices and role rules come from `shop.activePreset`:

| Preset | Prices | Who can buy | How many tickets |
| --- | --- | --- | --- |
| `standard` (default) | 50 / 90 / 130 / 170 | UnbelievaBoat shop rules | One of each tier per week. Tiers stack. |
| `launch-week` | 10 / 30 / 50 / 100 | `@verified` for every tier | One tier only. A higher tier replaces a lower one and does not refund it. |
| `posted-announcement` | 10 / 19 / 28 / 37 | No role required | One of each tier per week. Tiers stack. |

Change the preset later with `/set-preset` without editing the file. `/purchase-limit` turns the one-per-tier limit on or off for a special event and keeps the current prices.

Diamond exists in every preset and is **off**. The playbook never set a Diamond price. The placeholder is 210 PlayBits and 5 entries. Do not enable it until you pick a real price.

`weeklyReset.resetBalances` is forced back to false if you set it to true. The weekly reset never changes PlayBits.

Chat awards are 1 PlayBit per message, 60 second cooldown per member (not per channel), only with the verified role, only in the chat channels. Messages that are too short, emoji-only, the same text repeated inside 10 minutes, or old `p!` commands do not pay. Tune this under `chat`.

A server boost grants Playfull Patron and 40 PlayBits once per boost. A purchase claim in the same week does not pay a second 40, because `boost.countsAsPurchase` is true. Set `boost.grantPlayBits` to `0` if a boost should grant the role only.

## 5. Run it on your computer first

Install Node.js 22 or newer, then from this folder:

```bash
npm install
npm test
npm run build
npm start
```

`npm test` does not connect to Discord. `npm start` logs in and registers the slash commands on your server. In Discord, type `/` and look for `/help`. New commands can take a minute to appear.

Stop the test with Ctrl+C before you start the 24/7 copy, or you will have two bots fighting over the same database idea (they do not share a database unless you point them at the same file, which you should not).

## 6. Keep it online

The bot has to stay connected. Gaming Hub time is only counted while it is online, and a sleeping laptop or a free web host that spins down will miss voice time and can miss the end of a giveaway.

Use a small Linux VPS. The straightforward cheap option is **Hetzner Cloud's smallest server** (shared CPU, Ubuntu 24.04). A DigitalOcean basic droplet is the same idea if you already have an account. Expect a few dollars a month. Do not use a serverless host that sleeps.

On a fresh Ubuntu server, as a sudo user:

```bash
sudo apt update
sudo apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3

sudo useradd --system --create-home --shell /bin/bash playfull
sudo mkdir -p /opt/playfull-bot
sudo chown playfull:playfull /opt/playfull-bot
sudo -u playfull -H bash
cd /opt/playfull-bot
git clone <this-repo-url> .
npm install
npm run build
cp config/config.example.json config/config.json
cp .env.example .env
nano config/config.json
nano .env
exit
```

`npm install` compiles the database library, which is why `build-essential` and `python3` are installed.

Find the real Node path with `which node` (often `/usr/bin/node`). Edit `deploy/playfull-bot.service` if it differs, then:

```bash
sudo cp /opt/playfull-bot/deploy/playfull-bot.service /etc/systemd/system/playfull-bot.service
sudo systemctl daemon-reload
sudo systemctl enable --now playfull-bot
sudo systemctl status playfull-bot
sudo journalctl -u playfull-bot -f
```

You want a log line like `Logged in as Playfull#...` and `Registered ... commands.` After a reboot the service starts on its own.

Updates later:

```bash
cd /opt/playfull-bot
sudo -u playfull git pull
sudo -u playfull npm install
sudo -u playfull npm run build
sudo systemctl restart playfull-bot
```

The database file is `data/playfull.db`. Back it up before upgrades. It is not in git.

## 7. Import PlayBits from UnbelievaBoat

Do this before UnbelievaBoat is still paying chat money, or members will be paid twice. Export a spreadsheet that includes the **Discord user ID** (not just the username). Developer Mode → right-click a user → Copy User ID.

`examples/balances.csv` shows the shape:

```text
user_id,cash,bank
100000000000000001,42,0
```

A single `balance` or `playbits` column is also fine. That amount is stored as cash and the bank is set to 0. JSON like `[{"discord_id":"...","balance":"80"}]` works too.

In `#admin-cmds`, as someone with the Discord Management role:

1. `/import-balances` with the file, mode **set**, apply **false**. Read the preview.
2. Run it again with apply **true**.

`set` makes each person's balance match the file. It does **not** also add the starting 5. People who are missing from the file still get 5 PlayBits the first time the bot sees them.

Turn off UnbelievaBoat chat money, its shop, and Giveaway Boat before the new bot's first real week. Then run `/weekly-reset` with confirm true once, at the start of a week, to clear old ticket and activity roles. That command does not change PlayBits. It does remove Trend Hunter, Game Creator, Party Legend, and Playmaker. It does not remove Playfull Patron.

## Weekly routine for moderators

All of these staff commands work only in `#admin-cmds`.

1. `/status` to confirm the preset, prices, and that last week's tickets are gone.
2. `/giveaway-create` with the Steam game name. Duration defaults to 168 hours (7 days). The winner thread message can use `{winner}` and `{prize}`.
3. Members earn PlayBits, buy tickets, and press **Enter** on the giveaway. If captcha is on, they answer a small addition question first.
4. Activity rewards: the member uses `/claim`, or you use `/award`. Approve or Deny on the card in `#admin-cmds`. Approving pays the PlayBits and adds the role. The same activity cannot be approved twice in one week. You cannot approve your own claim.
5. Gaming Hub: `/voice-report` shows who has 30 minutes this week. Approve on a Gaming Hub claim is blocked under 30 minutes. **Approve anyway** is there if you checked another way. Deafened time is not counted. Muted time is counted, because people mute while they play.
6. When the timer ends, the bot draws a winner, edits the giveaway, posts in `#events`, and opens a private thread with the winner. If the server cannot make a private thread, it tries to DM them instead.
7. Deliver the Steam key. If the winner is ineligible, `/giveaway-reroll`.
8. After delivery, `/weekly-reset` with confirm true. Tickets and the four temporary roles go away. PlayBits stay.

`/giveaway-end` draws immediately if you cannot wait for the timer. The automatic weekly reset is off. The playbook says to clean up after the key is delivered, not at the moment of the draw. Set `giveaway.autoWeeklyReset` to true only if you want the cleanup to happen by itself when the winner is drawn.

## Member commands

These work in any channel unless you fill `channels.memberEconomy` (then `/balance`, `/leaderboard`, `/deposit`, and `/withdraw` only work there and in the admin channel). Ticket purchases only work in the shop channel.

| Command | What it does |
| --- | --- |
| `/balance` | Cash, bank, and total. A moderator can pass a member, in the admin channel. |
| `/leaderboard` | Richest members by cash plus bank. |
| `/deposit` and `/withdraw` | Move PlayBits between cash and bank. The shop spends **cash** only. |
| `/shop` and `/buy` | Ticket prices and a purchase. |
| `/tickets` | Tickets you hold and the giveaway weight they are worth. |
| `/claim` | Ask for an activity reward. Include a link or short proof. |
| `/voice-time` | Your Gaming Hub minutes this week. |
| `/help` | Short command list. |

Buying another tier after you have already pressed Enter updates your weight at draw time. You do not need to press Enter again.

## Staff commands

| Command | Who | What it does |
| --- | --- | --- |
| `/add-money` | Mod | Add cash PlayBits. Written to the vault channel. You cannot pay yourself. |
| `/remove-money` | Mod | Remove cash or bank PlayBits. Refuses if the balance is too low. |
| `/history` | Mod | Last balance changes for a member. |
| `/award` | Mod | Grant an activity reward and role without a claim button. |
| `/voice-report` | Mod | Who has Gaming Hub time this week. |
| `/revoke-ticket` | Mod | Remove an active ticket. Optional refund to cash. |
| `/giveaway-end` | Mod | Draw now. |
| `/giveaway-reroll` | Mod | New winner, previous winners excluded. |
| `/post-shop` | Mod | Post the shop with buy buttons. |
| `/post-guide` | Mod | Post the how-to in giveaways, or the activity list in the shop. Optional Giveaway Alerts ping. |
| `/status` | Mod | Week number, preset, prices, active giveaway, PlayBits in circulation. |
| `/giveaway-create` | Management | Start the week. |
| `/giveaway-cancel` | Management | Cancel without a winner. Does not expire tickets. |
| `/weekly-reset` | Management | Expire tickets and temporary roles. Does not touch PlayBits. |
| `/set-preset` | Management | `standard`, `launch-week`, or `posted-announcement`. |
| `/purchase-limit` | Management | Turn the one-per-tier weekly cap on or off. |
| `/import-balances` | Management | Load a CSV. Preview with apply false. |

Activity rewards, once per week:

| Activity | PlayBits | Role |
| --- | --- | --- |
| Trending gameplay | 10 | Trend Hunter |
| Original gameplay | 20 | Game Creator |
| Game Nights | 25 | Party Legend |
| Gaming Hub, 30 minutes | 30 | Playmaker |
| Playfull purchase, or a new server boost | 40 | Playfull Patron (kept) |

## Playbook contradictions

The giveaway playbook disagrees with itself. Defaults follow the UnbelievaBoat shop config, which is what you asked for. Change a preset or a field if you decide otherwise.

1. **Three different price lists.** The UnbelievaBoat shop and the rules tables say 50 / 90 / 130 / 170. The posted `#giveaways` and `#playbits-shop` messages say 10 / 19 / 28 / 37. The Special Launch Week table says 10 / 30 / 50 / 100. Default is 50 / 90 / 130 / 170. `launch-week` uses the launch-week table, not the posted 10 / 19 / 28 / 37 numbers, because those two "discount" lists are not the same. `posted-announcement` is the 10 / 19 / 28 / 37 list if you decide the channel posts are what is live.

2. **Gold's required role.** The rules say Party Legend only. The role table says Party Legend unlocks Gold and Playmaker unlocks Platinum. The shop says Party Legend **or** Playmaker. Default is Party Legend or Playmaker.

3. **Platinum's required role.** The rules say Playmaker. The role table says Playmaker unlocks Platinum and Playfull Patron unlocks Diamond. Tables 1, 6, and 9 say Playfull Patron only. The shop item text says Playfull Patron **or** Server Booster. Default is Playfull Patron or Server Booster.

4. **Diamond.** The rules and the role table include a Diamond ticket that requires Playfull Patron. The shop, Giveaway Boat's required roles, and the public posts never configure it. It is in the config and disabled. 210 PlayBits and 5 entries are placeholders, not playbook numbers.

5. **Does Playfull Patron expire?** The weekly cleanup list includes it. The moderator guide and the purchase steps say it is permanent and must not be removed in the mass role cleanup. Default: never removed. `rolesNeverRemove` wins even if the name is also in `rolesToRemove`.

6. **When tickets expire.** The main rules and the weekly cleanup say tickets expire when the raffle ends. The moderator guide says a member can hold a ticket as long as they want, and it is only used up if they entered a giveaway that then ends. Default: `/weekly-reset` expires every active ticket, entered or not.

7. **Launch week purchase rule.** Normal rules and the public post say one ticket **per tier** (Bronze and Silver in the same week is fine). The launch-week prose says a member may hold only one tier, and buying a higher tier replaces the lower role. The launch-week table still says "1 / week" on each row, which reads like the normal per-tier cap. The `launch-week` preset follows the prose: one tier, higher replaces lower, no refund. Set `refundReplacedTicket` to true in that preset if you want the cheaper ticket's cost returned.

8. **Who can buy during launch week.** The launch section says every tier is open to `@verified`. The public post says tiers are "open to @everyone" and, in the same sentence, that roles decide the tier. Standard Bronze has no role requirement. Launch week requires verified. The posted-announcement preset has no role requirements.

9. **Launch week or launch month.** Headings say both "Week 1 only" and "Launch Month". The preset does not turn itself off. Switch back with `/set-preset standard` when you want normal prices.

10. **Where staff commands run.** One section says every admin and mod command runs only in `#admin-cmds`. The command reference says currency changes run in `#cmds`. The public post tells members to use `p!balance` in `#bot-chat`. Default: staff commands only in `#admin-cmds`. Member balance, leaderboard, deposit, and withdraw work in any channel until you set `channels.memberEconomy`.

11. **Withdraw's description is a copy of deposit.** The command reference says withdraw "deposits cash into your bank." `/withdraw` moves bank to cash. `/deposit` moves cash to bank.

12. **`/role add`'s description is the same copy-paste.** This bot does not have a generic role command, because the playbook warns that the wrong role unlocks ticket tiers or staff access. It only grants the roles named in the config, and only from a claim, an award, a purchase, or a boost.

13. **Bank on or off.** The account table says the bank is inactive because `p!rob` is disabled, and deposits are optional. The troubleshooting section tells members to `/withdraw` when the shop says they are short because the money is in the bank. Deposit and withdraw exist. The shop spends cash only. There is no rob command.

14. **Chat and the verified role.** The activities chapter says chatting earns 1 PlayBit and does not mention `@verified`. The public giveaway post says chat only counts with `@verified`. Default: verified is required. Set `chat.requireVerified` to false to drop that.

15. **Does a boost pay 40 PlayBits or only the role?** Some lines say boosting qualifies for Playfull Patron. The activity table bundles "Playfull Purchase / Server Boost" as 40 PlayBits plus the role. Default: a new boost grants the role and 40 PlayBits, once per boost, and it shares the weekly purchase reward. Set `boost.grantPlayBits` to 0 for the role only.

16. **Game Night steps omit the role command.** The other activities show both `p!add-money` and `/role add`. Game Nights only shows the money command, then says to assign Party Legend. Approving a Game Night claim grants both.

17. **Ticket roles are missing from the mass-role list.** The cleanup prose says to expire ticket roles. The four `p!mass-role` commands that follow only remove activity roles. `/weekly-reset` removes both the four activity roles and the ticket-holder roles.

18. **Giveaway Boat "Extra Entries" has no amounts.** Stack Entries is on, and the ticket weights are 1 / 2 / 3 / 4. No other bonus entries were written down, so weight comes only from tickets. Set `giveaway.stackEntries` to false if only the highest ticket should count.

19. **The winner thread message is "TBD".** The default template congratulates `{winner}` on `{prize}` and asks them to reply if the game is region-locked. Pass `winner_message` on `/giveaway-create` to replace it for that week.

20. **Starting balance, no cap, and no weekly PlayBits reset** are consistent in the playbook and are the defaults (start at 5, no max, reset does not touch balances).

## Troubleshooting

- **Slash commands missing.** Check `DISCORD_CLIENT_ID`, `guildId`, and that the bot is in the server. Restart it and wait a minute.
- **Chat pays nobody.** Message Content Intent off, the member lacks `@verified`, the channel name does not match, or the message was too short or a duplicate.
- **Role was not added.** The bot's role is below the role it tried to give, or Manage Roles was removed. The PlayBits change is still in the vault. Fix the role order and add the role by hand, or `/revoke-ticket` with a refund if it was a purchase.
- **"Not enough PlayBits" while `/balance` looks high enough.** The shop spends cash. The rest may be in the bank. `/withdraw` with all set to true.
- **Voice time looks low.** The bot was offline, the member was deafened, or the voice channel name does not match `gamingHubVoice`. Time while the process is down is not counted.
- **Private winner thread failed.** The channel has to allow private threads. The bot falls back to a DM and logs the error. `#events` still gets the announcement.
- **Import rejected a row.** User IDs must be 17 to 20 digits. Usernames alone cannot be imported.

## Development

```bash
npm test
npm run typecheck
npm run build
npm run dev
```

Tests cover balances and the ledger, ticket purchase limits and the three price presets, the weighted draw and reroll, and the weekly reset (tickets and temporary roles expire, Patron stays, PlayBits do not move). They do not connect to Discord.
