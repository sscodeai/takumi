# Request: station temperature summary

I want a small command-line tool that reads a CSV export of daily temperature readings
(`date,station,temperature_c`) and prints, per station, how many readings there were, the lowest, the
highest and the mean temperature in degrees Celsius with one decimal place. It should also print the
number of rows across all stations.

Rows that cannot be parsed should be handled sensibly rather than crashing the tool.

The tool has to run on a developer laptop with no network access, and a year of readings (about
200,000 rows) should finish in a couple of seconds.
