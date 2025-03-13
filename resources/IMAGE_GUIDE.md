# Image Creation Guide for LineSight

This document provides instructions for creating the necessary images for the LineSight extension.

## Required Images

1. **Icon (logo.png)**
   - Size: 128x128 pixels
   - Format: PNG with transparency
   - Location: `resources/images/logo.png`
   - Used as the extension icon in the marketplace

2. **Logo SVG (logo.svg)**
   - Format: SVG (vector)
   - Location: `resources/images/logo.svg`
   - Used in the README and for creating other assets

3. **Screenshot (screenshot.png)**
   - Size: Recommended 1280x800 pixels
   - Format: PNG
   - Location: `resources/images/screenshot.png`
   - Should show the VS Code explorer with line count badges visible
   - Tip: Use a project with files of varying line counts to demonstrate the feature

4. **Banner (banner.png)** (Optional)
   - Size: 1280x320 pixels
   - Format: PNG
   - Location: `resources/images/banner.png`
   - Used for promotional purposes

## Creating the Images

### For the Logo

1. Use the provided SVG as a starting point
2. Export to PNG at 128x128 pixels
3. Ensure the background is transparent
4. The logo should be clear and recognizable at small sizes

### For the Screenshot

1. Open VS Code with the LineSight extension installed
2. Open a project with various files
3. Ensure the explorer view shows files with line count badges
4. Take a screenshot that clearly demonstrates the functionality
5. Crop to an appropriate size (recommend 1280x800px)

### For the Banner

1. Create a promotional banner that includes:
   - The LineSight name and logo
   - A brief tagline ("Line counts in your file explorer")
   - Visual elements that represent code files with line counts
   - VS Code theme-appropriate colors (dark or light based on your target audience)

## VS Code Marketplace Image Guidelines

- Keep images clean and professional
- Ensure text is readable
- Follow VS Code's visual language
- Use high-quality images that aren't pixelated
- Consider both light and dark theme users

## Converting SVG to PNG

You can convert the SVG to PNG using:

- Inkscape (free, open-source)
- Adobe Illustrator
- GIMP
- Online converters like [SVG2PNG](https://svgtopng.com/)

When exporting, ensure you maintain the correct dimensions and transparency. 