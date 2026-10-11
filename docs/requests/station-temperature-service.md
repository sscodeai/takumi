# Request: station temperature summary HTTP service

I want a tiny **HTTP service** — not a command-line script — that summarises a CSV export of daily
temperature readings (`date,station,temperature_c`).

It must expose a JSON endpoint (for example `GET /summary`) that returns, per station, how many
readings there were, the lowest, the highest and the mean temperature in degrees Celsius with one
decimal place, plus the number of rows across all stations. The response is JSON, not a printed table.

The service has to be **started** (there is no "run it once on a file and exit" mode), so the project
must declare how it is built, how its own tests are run, and how it is started and reached over HTTP.
Rows that cannot be parsed should be handled sensibly rather than crashing the service.

It has to run on a developer laptop with no network access, and a year of readings (about 200,000 rows)
should be summarised in a couple of seconds.
