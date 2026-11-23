// How to drop roofline pins in Google Earth so the Solasta API's KML reader (KmlRooflineParser, RooflinePins,
// RooflineAnalyzer) measures them the way staff do. Keep it in step with those classes' naming rules.

export const KML_GUIDE_URI = 'solasta://guides/roofline-kml'

export type GuideDevice = 'desktop' | 'phone'

const COMMON = `# How to map your roofline in Google Earth

You will drop a pin at every corner of the roofline you want lit, give each pin a name, and save the pins as a KML file.
It takes 15 to 30 minutes for most homes.

## Name the pins

- Walk around the house one side at a time: **Front**, **Right**, **Back**, **Left** (as seen from the street).
- Number the pins along each side in order, starting at 1: \`Front 001\`, \`Front 002\`, \`Front 003\`...
- A pin on a corner where two sides meet gets both names, joined with a plus: \`Front 005 + Right 001\`.
- Put a pin wherever the roofline changes direction (corners, gable peaks) and at both ends of every stretch you want lit.
- In each pin's description, write what it is:
  - \`LEC\` (left end cap) where a lit stretch starts, and \`REC\` (right end cap) where it ends. Read the stretch left to right as you face that side of the house.
  - \`Out Corner\` or \`In Corner\` at a corner, \`Gable\` at a gable peak.
- A second-story roofline goes in a folder named for its level, such as \`Front - lvl 2\`, or add \`lvl 2\` to the pin names.
- A lower roof below a side (a porch or garage roof) uses the side's first letter, a dash, the roof number and the pin: \`b-1.3\` is pin 3 of the first lower roof at the back.

## Before you send it

Ask me to check the file. I will read it the way the installer's tools do and tell you about any pin that does not connect, so you can fix it before you ask for a quote.
`

const DESKTOP = `
## Steps (Google Earth Pro on a computer, or Google Earth on the web)

1. Search for your address and zoom in until the roof fills the screen. Tilt the view (shift + drag) if the eaves are hard to see.
2. Make a folder for the house: right-click **My Places** (Pro) or open **Projects** > **New project** (web).
3. Add a placemark (the pin button) at the first corner. Type its name and description, then click **OK**.
4. Repeat for every corner, side by side, in order.
5. Save the folder as a KML file: right-click it > **Save Place As...** > choose **KML** (Pro), or **Export as KML file** (web).
6. Open the file in a text editor and paste its text here, or attach it if your assistant accepts files.
`

const PHONE = `
## Steps (Google Earth app on a phone or tablet)

1. Open Google Earth, search for your address and zoom in on the roof.
2. Tap **Projects** > **New project** > **Create KML file**, and name it after your address.
3. Tap **Add placemark**, move the pin to the first corner, tap **Select this location**, then type the name and description.
4. Repeat for every corner, side by side, in order.
5. Open the project's menu > **Export as KML file**, and share it to yourself. Paste the file's text here.

A phone screen makes small roofs fiddly. If you have a computer, the desktop steps are easier.
`

export function kmlGuide(device: GuideDevice | undefined): string {
  if (device === 'phone') return COMMON + PHONE
  if (device === 'desktop') return COMMON + DESKTOP
  return COMMON + DESKTOP + PHONE
}
