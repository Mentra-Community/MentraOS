package com.augmentos.augmentos_core.ui;

import android.content.Context;
import android.graphics.drawable.Drawable;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.ImageView;
import android.widget.TextView;

import com.augmentos.augmentos_core.R;
import com.augmentos.augmentos_core.smarterglassesmanager.supportedglasses.SmartGlassesDevice;

import java.util.ArrayList;

public class SmartGlassesListAdapter extends ArrayAdapter<SmartGlassesDevice> {
    Context mContext;
    private ArrayList<SmartGlassesDevice> glassesList;

    private int selectedPosition = -1;

    public SmartGlassesListAdapter(ArrayList<SmartGlassesDevice> glassesList, Context context) {
        super(context, R.layout.smart_glasses_list_item, glassesList);
        // TODO Auto-generated constructor stub

        this.mContext = context;
        this.glassesList = glassesList;
    }

    public int getSelectedPosition() {
        return selectedPosition;
    }

    public void setSelectedPosition(int selectedPosition) {
        this.selectedPosition = selectedPosition;
    }

    public SmartGlassesDevice getSelectedDevice(){
        if (this.selectedPosition != -1) {
            return this.glassesList.get(this.selectedPosition);
        } else {
            return null;
        }
    }

    @Override
    public View getView(int position, View convertView, ViewGroup parent) {
        SmartGlassesDevice device = this.glassesList.get(position);
        if (convertView == null) {
            convertView = LayoutInflater.from(mContext).inflate(R.layout.smart_glasses_list_item, parent, false);
        }
        TextView tvGlassesName = (TextView)convertView.findViewById(R.id.glasses_name);
        TextView tvGlassesSupport = (TextView)convertView.findViewById(R.id.glasses_support);
        ImageView ivGlassesIcon = (ImageView) convertView.findViewById(R.id.glasses_icon);

        //set device name
        tvGlassesName.setText(device.getDeviceModelName());

        //set device icon
        String uri = "@drawable/" + device.getDeviceIconName();  // where myresource (without the extension) is the file
        int imageResource = mContext.getResources().getIdentifier(uri, null, mContext.getPackageName());
        Drawable res = mContext.getResources().getDrawable(imageResource);
        ivGlassesIcon.setImageDrawable(res);

        //set device supported
        if (!device.getAnySupport()){
            tvGlassesSupport.setText("Not supported.");
        } else if (!device.getFullSupport()){
            tvGlassesSupport.setText("Partially supported.");
        } else {
            tvGlassesSupport.setText("Fully Supported");
        }

        return convertView;
    }
}