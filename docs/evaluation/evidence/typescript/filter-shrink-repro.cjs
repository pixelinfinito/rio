for (const version of ['base','head']) {
  for (const plugin of [false,true]) {
    const bundle = '/tmp/rio-immer-filter-'+version+'/immer.cjs';
    delete require.cache[require.resolve(bundle)];
    const {produce,enableArrayMethods} = require(bundle);
    if(plugin) enableArrayMethods();
    const observed=[];
    let result, error;
    try {
      produce([{id:1},{id:2}], draft => {
        draft.push({id:3});
        result = draft.filter((value,index) => {
          observed.push({index,value: value === undefined ? null : value.id});
          if(index===0) draft.length=1;
          return value.id>0;
        }).map(value=>value.id);
      });
    } catch (e) { error=e.message; }
    console.log(JSON.stringify({version,plugin,observed,result,error}));
  }
}
