# Bake mediamtx.yml into the image so Docker Desktop does not need to
# bind-mount a file from a USB drive (D: mounts often fail as "not a directory").
FROM bluenviron/mediamtx:1
COPY mediamtx.yml /mediamtx.yml
