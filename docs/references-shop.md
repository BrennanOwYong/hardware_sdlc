# References: shop listing scrape (data/images/shop)

Sources relied on for the simulated-acquisition listing set, fetched 2026-07-24. Full per-file attribution and store-blocking notes live in `data/images/shop/ATTRIBUTION.md`.

## Listing pages (authoritative source of title/price/currency/image)

- https://www.sparkfun.com/arduino-uno-r3.html (DEV-11021)
- https://www.sparkfun.com/led-assorted-20-pack.html (COM-12062)
- https://www.sparkfun.com/resistor-kit-1-4w-500-total.html (COM-10969)
- https://www.sparkfun.com/tactile-button-assortment.html (COM-10302)
- https://www.adafruit.com/product/64 (half-size breadboard)
- https://www.adafruit.com/product/758 (M/M jumper wires 40x)
- https://www.adafruit.com/product/2784 (10K resistor 25-pack)
- https://www.adafruit.com/product/367 (tactile buttons 20-pack)
- https://www.adafruit.com/product/386 (DHT11 + extras)
- https://www.adafruit.com/product/62 (USB A-B cable)
- https://www.aliexpress.com/item/1005007938089405.html (UNO R3 board)
- https://www.aliexpress.com/item/1005010759314914.html (UNO R3 starter kit)
- AliExpress search snapshot: https://www.aliexpress.com/w/wholesale-arduino-uno-r3.html (embedded JSON; SGD prices)

## Extraction methods

- Adafruit and SparkFun: `<script type="application/ld+json">` Product blocks (name, offers.price, offers.priceCurrency, image, availability).
- AliExpress: search-page embedded JSON split on `"productId":"`, fields `displayTitle`, `salePrice.formattedPrice`, `salePrice.currencyCode`, `imgUrl`. Item pages hydrate client-side and expose no price; search pages rate-limit hard after the first request (x5sec).
