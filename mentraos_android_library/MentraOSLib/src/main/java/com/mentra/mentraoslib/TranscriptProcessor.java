package com.mentra.mentraoslib;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;

public class TranscriptProcessor {

    private final int maxCharsPerLine;
    private final int maxLines;

    private final Deque<String> lines;

    private String partialText;

    public TranscriptProcessor(int maxCharsPerLine, int maxLines) {
        this.maxCharsPerLine = maxCharsPerLine;
        this.maxLines = maxLines;
        this.lines = new ArrayDeque<>();
        this.partialText = "";
    }

    public String processString(String newText, boolean isFinal) {
        newText = (newText == null) ? "" : newText.trim();

        if (!isFinal) {
            // Store this as the current partial text (overwriting old partial)
            partialText = newText;
            return buildPreview(partialText);
        } else {
            // We have a final text -> clear out the partial text to avoid duplication
            partialText = "";

            // Wrap this final text
            List<String> wrapped = wrapText(newText, maxCharsPerLine);
            for (String chunk : wrapped) {
                appendToLines(chunk);
            }

            // Return only the finalized lines
            return getTranscript();
        }
    }

    private String buildPreview(String partial) {
        // Wrap the partial text
        List<String> partialChunks = wrapText(partial, maxCharsPerLine);

        // Combine with finalized lines
        List<String> combined = new ArrayList<>(lines);
        combined.addAll(partialChunks);

        // Truncate if necessary
        if (combined.size() > maxLines) {
            combined = combined.subList(combined.size() - maxLines, combined.size());
        }

        // Add padding to ensure exactly maxLines are displayed
        int linesToPad = maxLines - combined.size();
        for (int i = 0; i < linesToPad; i++) {
            combined.add(""); // Add empty lines at the end
        }

        return String.join("\n", combined);
    }

    private void appendToLines(String chunk) {
        if (lines.isEmpty()) {
            lines.addLast(chunk);
        } else {
            String lastLine = lines.removeLast();
            String candidate = lastLine.isEmpty() ? chunk : lastLine + " " + chunk;

            if (candidate.length() <= maxCharsPerLine) {
                lines.addLast(candidate);
            } else {
                // Put back the last line if it doesn't fit
                lines.addLast(lastLine);
                lines.addLast(chunk);
            }
        }

        // Ensure we don't exceed maxLines
        while (lines.size() > maxLines) {
            lines.removeFirst();
        }
    }

    private List<String> wrapText(String text, int maxLineLength) {
        List<String> result = new ArrayList<>();
        while (!text.isEmpty()) {
            if (text.length() <= maxLineLength) {
                result.add(text);
                break;
            } else {
                int splitIndex = maxLineLength;
                // move splitIndex left until we find a space
                while (splitIndex > 0 && text.charAt(splitIndex) != ' ') {
                    splitIndex--;
                }
                // If we didn't find a space, force split
                if (splitIndex == 0) {
                    splitIndex = maxLineLength;
                }

                String chunk = text.substring(0, splitIndex).trim();
                result.add(chunk);
                text = text.substring(splitIndex).trim();
            }
        }
        return result;
    }

    public String getTranscript() {
        // Create a copy of the lines for manipulation
        List<String> allLines = new ArrayList<>(lines);

        // Add padding to ensure exactly maxLines are displayed
        int linesToPad = maxLines - allLines.size();
        for (int i = 0; i < linesToPad; i++) {
            allLines.add(""); // Add empty lines at the end
        }

        String finalString = String.join("\n", allLines);

        lines.clear();

        return finalString;
    }


    public void clear() {
        lines.clear();
        partialText = "";
    }

    public int getMaxCharsPerLine() {
        return maxCharsPerLine;
    }

    public int getMaxLines() {
        return maxLines;
    }
}