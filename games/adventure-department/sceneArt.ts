/**
 * Original native AGI compositions for the tutorial rooms.
 *
 * These sources deliberately use a few large filled regions and crisp vector
 * accents. They are authored for 160x168 logical pixels (displayed at 2:1),
 * leaving the interactive actors and room control overlays to game.ts.
 */

const GALLERY_PICTURE = String.raw`
# Picture Gallery: cool plaster, a beveled mural, and one oak restoration bench.
pri off
vis 0
rect 0,0 159,167
line 0,15 159,15
line 0,112 159,112
line 8,132 35,112
line 140,112 151,128

# Asymmetric timber ceiling and wall posts.
polygon 0,0 159,0 159,8 132,8 119,15 34,15 20,8 0,8
polygon 8,15 17,15 17,119 8,132
polygon 142,15 151,15 151,128 140,112
line 20,8 34,15
line 132,8 119,15

# Beveled mural frame; the inner box is the exact repair overlay area.
rect 53,31 102,78
rect 56,34 99,75
rect 57,35 98,72
line 54,32 101,32
line 54,32 54,77
line 56,75 99,75
line 99,34 99,75

# Two simple museum sconces flank the exhibit.
polygon 35,45 41,45 43,50 40,54 36,54 33,50
line 38,39 38,45
polygon 114,45 120,45 123,50 120,54 116,54 113,50
line 118,39 118,45

# Restoration bench: one strong silhouette with three cabinet bays.
polygon 42,88 121,88 126,94 122,99 43,99 38,94
rect 43,99 122,111
line 68,99 68,111
line 95,99 95,111
line 39,112 126,112
line 47,111 45,119
line 117,111 119,119
line 51,104 60,104
line 77,104 86,104
line 103,104 112,104

# A grouped restoration kit, kept clear of the mural.
rect 22,89 34,107
line 20,108 36,108
polygon 25,86 31,86 33,89 23,89
line 26,98 30,98
polygon 105,82 109,82 110,88 104,88
polygon 112,80 116,80 117,88 111,88

# Region fills.
vis 6
fill 2,3 2,20 10,20 10,114 146,20 154,20 20,115 145,115 55,33 40,93 44,102 70,102 97,102 24,92 106,84 113,83
vis 3
fill 30,30 130,30
vis 7
fill 58,36
vis 14
fill 36,49 116,49
vis 1
fill 80,145
vis 8
fill 2,11 140,11

# Sparse highlights establish material and depth.
vis 14
line 22,7 129,7
line 18,16 140,16
vis 6
line 18,84 52,84
line 103,84 141,84
vis 14
line 55,33 100,33
line 55,33 55,76
line 57,73 98,73
line 57,74 98,74
vis 6
line 55,76 100,76
line 100,33 100,76
vis 14
line 44,89 119,89
line 45,100 66,100 66,109
line 70,100 93,100 93,109
line 97,100 120,100 120,109
vis 8
line 34,113 13,150
line 126,113 148,150
vis 9
line 53,126 107,126
end
`;

const LAB_PICTURE = String.raw`
# Sprite Lab: a clean machine room with one lever, console, and robot bay.
pri off
vis 0
rect 0,0 159,167
line 0,18 159,18
line 0,112 159,112
line 8,119 26,112
line 134,112 151,119

# Heavy ceiling beam and two unequal braces.
polygon 0,0 159,0 159,9 135,9 125,18 31,18 18,9 0,9
polygon 8,18 16,18 16,116 8,119
polygon 143,18 151,18 151,119 143,116
line 18,9 31,18
line 135,9 125,18

# Compact mounting plate for the animated lever VIEW.
polygon 29,75 47,75 50,78 50,108 47,111 29,111 26,108 26,78
rect 29,79 47,108
line 29,79 47,79

# Robot alcove remains deliberately empty and pale behind the 13x32 actor.
polygon 88,40 122,40 127,45 127,112 84,112 84,45
rect 91,46 120,112
polygon 97,34 113,34 117,40 93,40
line 95,50 116,50
polygon 91,46 96,51 96,107 91,109
rect 91,109 120,112

# Compact teaching console, grouped away from the robot silhouette.
polygon 55,86 79,86 85,92 81,98 55,98 50,92
rect 55,98 81,110
rect 59,90 76,96
line 61,102 76,102
line 61,106 69,106

# Three-vial lesson rack: distinct shapes, no surface texture.
line 56,60 77,60
line 57,72 76,72
rect 59,62 63,71
rect 65,64 69,71
rect 71,61 75,71

# Region fills.
vis 6
fill 2,3 2,25 10,25 10,114 146,25 146,114 154,25 18,113 140,113 27,80 86,50 123,50 90,43 51,92 56,102 92,110
vis 3
fill 24,30 136,30 52,100 83,100
vis 7
fill 100,52
fill 30,80
vis 12
fill 60,64 72,63
vis 9
fill 60,91 66,66
vis 1
fill 80,145
vis 8
fill 2,12 154,12 93,52

# A few purposeful machine highlights and floor guides.
vis 14
fill 100,36
line 20,8 133,8
pen 0
plot 29,80 47,80 29,107 47,107
line 89,41 121,41
line 56,87 78,87
line 58,99 79,99
vis 8
line 26,113 9,146
line 134,113 150,146
vis 9
line 57,126 103,126
end
`;

const ARCHIVE_PICTURE = String.raw`
# Priority Archive: balanced oak records, a clear clerk backdrop, and a counter.
pri off
vis 0
rect 0,0 159,167
line 0,16 159,16
line 0,112 159,112
line 8,124 25,112
line 134,112 151,128

# Ceiling beam and side uprights frame the archive.
polygon 0,0 159,0 159,8 137,8 122,16 34,16 20,8 0,8
polygon 8,16 16,16 16,119 8,124
polygon 143,16 151,16 151,128 136,112
line 20,8 34,16
line 137,8 122,16

# Two unequal record cabinets leave a quiet center field behind Felix's head.
polygon 19,34 24,29 49,29 57,39 57,88 18,88 18,39
rect 23,41 52,84
line 23,55 52,55
line 23,70 52,70
polygon 108,34 113,27 136,27 142,39 142,88 103,88 103,39
rect 108,41 137,84
line 108,55 137,55
line 108,70 137,70

# Broad document bundles; three accents per cabinet.
rect 27,44 43,51
rect 30,59 49,66
rect 25,74 40,81
rect 112,44 129,51
rect 115,59 133,66
rect 110,74 126,81
line 31,45 31,50
line 117,60 117,65

# Department seal and pendant lamp mark the center service point.
polygon 73,39 80,34 87,39 87,48 80,53 73,48
polygon 77,41 80,38 83,41 83,46 80,49 77,46
line 80,16 80,29
polygon 74,29 86,29 90,35 70,35

# Counter top begins at 85; its visible and priority extents agree exactly.
rect 56,85 118,98
line 56,91 118,91
rect 56,98 118,121
line 77,98 77,121
line 98,98 98,121
rect 81,104 93,112
line 53,122 121,122
line 60,121 58,130
line 114,121 116,130

# Region fills.
vis 6
fill 2,3 2,23 10,23 10,114 146,23 154,23 18,113 140,113 20,38 105,38 140,50 57,101 58,113 100,101 100,113
vis 3
fill 62,30 95,30 125,100
vis 7
fill 24,42 109,42 78,31 75,40 79,100 82,106 82,113
vis 4
fill 28,45 33,45 116,60 120,61
vis 1
fill 34,61 118,45 80,145
vis 5
fill 27,76 111,76
vis 8
fill 2,11 140,11 24,56 24,71 109,56 109,71
vis 14
fill 80,42 58,89 58,93

# Restrained edge light and floor perspective.
vis 14
line 22,7 134,7
line 20,35 51,35
line 109,35 139,35
line 57,86 117,86
line 57,99 75,99 75,119
line 79,99 96,99 96,119
line 100,99 116,99 116,119
vis 8
line 57,118 75,118
line 79,118 96,118
line 100,118 116,118
line 25,113 10,147
line 134,113 150,147
vis 9
line 47,135 111,135
end
`;

export const ORIGINAL_SCENE_PICTURES: Readonly<Record<number, string>> = {
  1: GALLERY_PICTURE,
  2: LAB_PICTURE,
  3: ARCHIVE_PICTURE,
};
