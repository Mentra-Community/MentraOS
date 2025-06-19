package com.mentra.mentraoslib;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.UUID;

public class AugmentOSCallbackMapper {
    public HashMap<UUID, AugmentOSCommandWithCallback> registeredCommands;

    public AugmentOSCallbackMapper(){
        registeredCommands = new HashMap<>();
    }

    public void putCommandWithCallback(AugmentOSCommand command, AugmentOSCallback callback){
        registeredCommands.put(command.getId(), new AugmentOSCommandWithCallback(command, callback));
    }

    public AugmentOSCallback getCommandCallback(AugmentOSCommand command){
        AugmentOSCommandWithCallback cwc = registeredCommands.get(command.getId());
        if (cwc != null){
            return cwc.callback;
        } else {
            return null;
        }
    }

    public ArrayList<AugmentOSCommand> getCommandsList(){
        ArrayList<AugmentOSCommand> commandsList = new ArrayList<>();
        for (AugmentOSCommandWithCallback cwc : registeredCommands.values()){
           commandsList.add(cwc.command);
        }
        return commandsList;
    }
}
