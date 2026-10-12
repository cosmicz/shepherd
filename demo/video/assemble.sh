#!/bin/bash
# Assemble demo/video/shepherd-demo.mp4: title, bridge, explicit demo recordings, numbers, end.
# Usage: demo/video/assemble.sh [demo-recording.mov ...]   (recordings are inserted after the bridge card)
set -e
V="$(cd "$(dirname "$0")" && pwd)"; B="$V/build"; cd "$V"
norm() { # input output: 1920x1080 30fps yuv420p, stereo aac 48k
  ffmpeg -v error -y -i "$1" -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,fps=30,format=yuv420p" \
    -c:v libx264 -preset veryfast -crf 20 -ac 2 -ar 48000 -c:a aac -b:a 160k "$2"; }
cardclip() { # png seconds output
  ffmpeg -v error -y -loop 1 -t "$2" -i "$1" -f lavfi -t "$2" -i anullsrc=r=48000:cl=stereo \
    -vf "fps=30,format=yuv420p" -c:v libx264 -preset veryfast -crf 20 -c:a aac -b:a 160k -shortest "$3"; }
cardclip "$B/title.png" 5 "$B/00-title.mp4"
cardclip "$B/bridge.png" 4 "$B/20-bridge.mp4"
i=0; for d in "$@"; do i=$((i+1)); norm "$d" "$B/3$i-demo.mp4"; done
cardclip "$B/numbers.png" 8 "$B/40-numbers.mp4"
cardclip "$B/end.png" 4 "$B/50-end.mp4"
ls "$B"/*.mp4 | sort | sed "s/.*/file '&'/" > "$B/list.txt"
ffmpeg -v error -y -f concat -safe 0 -i "$B/list.txt" -c copy "$V/shepherd-demo.mp4"
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$V/shepherd-demo.mp4" | awk '{printf "shepherd-demo.mp4: %d:%02d\n", $1/60, $1%60}'
