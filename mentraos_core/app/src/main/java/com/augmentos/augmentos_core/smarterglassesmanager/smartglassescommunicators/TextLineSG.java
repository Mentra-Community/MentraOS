package com.augmentos.augmentos_core.smarterglassesmanager.smartglassescommunicators;

public class TextLineSG {
    private String text;
    private int fontSize;

    public TextLineSG(String text, int fontSize){
        this.text = text;
        this.fontSize = fontSize;
    }

    public String getText() {
        return text;
    }

    public void setText(String text) {
        this.text = text;
    }

    public int getFontSizeCode() {
        return fontSize;
    }

    public void setFontSize(int fontSize) {
        this.fontSize = fontSize;
    }
}
